'use strict';
/**
 * tests/artisan-account.test.cjs — the Account tab (Phase 5).
 *
 * Runs artisan-app/js/account.js, which decides what each Account control
 * shows and writes, and checks that artisan-app/settings.html carries it out.
 * The rendered tab is tests/e2e/artisan_account.py.
 *
 * Findings from the Phase 5 inspection this pins:
 *   · "We review applications within 1–2 business days" (decision 3: removed);
 *   · a Dark mode switch on a system whose dark theme is held for Phase 6
 *     (decision 04);
 *   · closing an account could show Firebase's raw error text;
 *   · the phone was saved as typed, accepting non-Ghana numbers the server's
 *     sign-up refuses;
 *   · the password reset went around the auth service to the raw SDK.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const page = read('artisan-app/settings.html');
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page)[1];
const markup = page.replace(/<script[\s\S]*?<\/script>/g, '');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}
const N = '2026-11-09T12:00:00.000Z';

(async () => {
    const a = await import(pathToFileURL(path.join(ROOT, 'artisan-app/js/account.js')).href);
    const ob = await import(pathToFileURL(path.join(ROOT, 'artisan-app/js/onboarding.js')).href);

    console.log('\n── Verification: the server\'s status, in words ──\n');

    await t('each status has its words; approved links nowhere (onboarding bounces it); no review-time promise', () => {
        assert.deepStrictEqual(a.VERIFICATION.approved, { value: 'Verified', tone: 'ok', sub: 'Your documents are approved', link: false });
        assert.strictEqual(a.verificationView('pending_review').sub, 'Fidus X is checking your application');
        assert.strictEqual(a.verificationView('rejected').value, 'Action needed');
        assert.strictEqual(a.verificationView('').value, 'Not submitted');
        for (const v of Object.values(a.VERIFICATION)) assert.ok(!/day|hour|within/i.test(v.sub), v.sub);
        assert.match(read('artisan-app/onboarding.html'), /verificationStatus === 'approved'\) \{\s*window\.location\.href = 'dashboard\.html'/);
    });

    await t('the same reading as onboarding: an unknown status is "under review", never "not submitted"', () => {
        for (const s of ['', 'draft', 'rejected', 're_verification_required', 'pending_review', 'submitted', 'pending', 'approved']) {
            const phase = ob.applicationPhase({ verificationStatus: s });
            const view = a.verificationView(s);
            const expected = { fill: 'Not submitted', fix: 'Action needed', review: 'Under review', approved: 'Verified' }[phase];
            assert.strictEqual(view.value, expected, s);
        }
    });

    console.log('\n── Job radius: the field dispatch reads ──\n');

    await t('the choices are dispatch\'s (5–25 km), shared with onboarding; what is shown is what applies', () => {
        assert.deepStrictEqual([...a.RADIUS_CHOICES], [5, 10, 15, 20, 25]);
        assert.strictEqual(a.RADIUS_CHOICES, ob.RADIUS_CHOICES, 'one list');
        assert.strictEqual(a.effectiveRadius({}), 20, 'dispatch\'s default: a.workRadius || 20');
        assert.strictEqual(a.effectiveRadius({ workRadius: 100 }), 25, 'nothing beyond the 25 km search');
        assert.strictEqual(a.effectiveRadius({ workRadius: 10 }), 10);
        assert.deepStrictEqual(a.radiusPatch(15, N), { workRadius: 15, updatedAt: N });
        assert.match(read('functions/dispatch.js'), /25_000/);
        assert.match(read('functions/dispatch.js'), /a\.workRadius \|\| 20/);
        assert.match(script, /const patch = radiusPatch\(v, n\);\s*await databaseService\.updateDocument\('artisans', user\.uid, patch\);/);
    });

    console.log('\n── Push notifications: the preference, and this device ──\n');

    await t('the preference is saved on the profile, where the server reads it; not in this browser', () => {
        assert.deepStrictEqual(a.pushPatch(false, N), { notificationPreferences: { push: false, updatedAt: N }, updatedAt: N });
        assert.match(script, /const patch = pushPatch\(want, n\);\s*await databaseService\.updateDocument\('artisans', user\.uid, patch\);/);
        assert.ok(!/localStorage\.setItem\('artisan_pref_notifications'/.test(script));
        assert.match(script, /enablePushNotifications\(user\.uid, 'artisan'\)/);
        assert.match(read('functions/notifications.js'), /artisanPushAllowed/);
    });

    await t('the switch shows whether pushes reach this device; it never changes the saved preference', () => {
        assert.deepStrictEqual(a.pushView({ pref: true, device: 'blocked' }), { checked: false, text: a.DEVICE_LINE.blocked });
        assert.match(a.DEVICE_LINE.blocked, /^Blocked by this browser\./);
        assert.strictEqual(a.pushView({ pref: true, device: 'unsupported' }).checked, false);
        assert.deepStrictEqual(a.pushView({ pref: true, device: 'on' }), { checked: true, text: 'On for this device.' });
        for (const d of ['off', 'failed', 'pending']) assert.strictEqual(a.pushView({ pref: true, device: d }).checked, true, d);
        for (const d of ['on', 'blocked']) assert.match(a.pushView({ pref: false, device: d }).text, /^Off\./);
        assert.strictEqual(a.savedPush({}), true, 'absent means on');
        assert.strictEqual(a.savedPush({ notificationPreferences: { push: false } }), false);
        assert.match(script, /pushPref = want;[\s\S]*await describeDevice\(\);/, 'after a save, the device decides what the switch shows');
    });

    console.log('\n── Phone: private, a Ghana number as the server stores it ──\n');

    await t('the phone is checked as sign-up and onboarding check it, and stored normalised in private/contact', () => {
        assert.strictEqual(a.phoneProblem(''), 'Enter your mobile number.');
        assert.strictEqual(a.phoneProblem('+44 20 7946 0000'), 'Enter a Ghana mobile number, like 024 123 4567.');
        assert.strictEqual(a.phoneProblem('+233 24 123 4567'), null);
        assert.deepStrictEqual(a.contactPatch('A1', '024 123 4567', N), { artisanId: 'A1', phone: '0241234567', updatedAt: N });
        assert.match(script, /const patch = contactPatch\(user\.uid, raw, new Date\(\)\.toISOString\(\)\);\s*await databaseService\.setDocument\(`artisans\/\$\{user\.uid\}\/private`, 'contact', patch, \{ merge: true \}\);/);
        assert.ok(!/updateDocument\('artisans', user\.uid, \{[^}]*phone/.test(script), 'never the public profile');
    });

    console.log('\n── What Account never writes ──\n');

    await t('the payout account is shown masked and never written; the only private write is the phone', () => {
        assert.strictEqual(a.payoutLine({ payoutAccount: { provider: 'telecel', phone: '020 123 4567' } }), 'Telecel •••4567');
        assert.strictEqual(a.payoutLine(null), 'Not added');
        const privateWrites = script.match(/(update|set)Document\(`artisans\/\$\{user\.uid\}\/private`,\s*'[^']+'/g) || [];
        assert.deepStrictEqual(privateWrites.map((w) => w.match(/'([^']+)'$/)[1]), ['contact']);
        for (const w of script.match(/(update|set)Document\([^;]*;/g) || []) assert.ok(!/payoutAccount|momo/i.test(w), w);
    });

    await t('the profile writes are the radius and the push preference only — no claim, no status, no availability', () => {
        const writes = [...script.matchAll(/updateDocument\('artisans', user\.uid, (\w+)\)/g)].map((m) => m[1]);
        assert.deepStrictEqual(writes, ['patch', 'patch']);
        assert.ok(!/setAvailability|isAvailable|verificationStatus:|status:|name:|category:/.test(script.replace(/state\.verificationStatus/g, '')));
    });

    console.log('\n── Password, sign out, closing the account ──\n');

    await t('a password change proves the current one first, for password accounts only; success after Firebase accepts', () => {
        assert.deepStrictEqual(a.passwordProblem({ current: '', next: 'x', confirm: 'x' }), { field: 'current', message: 'Enter your current password.' });
        assert.strictEqual(a.passwordProblem({ current: 'a', next: 'short', confirm: 'short' }).field, 'next');
        assert.strictEqual(a.passwordProblem({ current: 'a', next: 'longenough', confirm: 'other1234' }).message, "The new passwords don't match.");
        assert.strictEqual(a.passwordProblem({ current: 'samesame1', next: 'samesame1', confirm: 'samesame1' }).message, 'Choose a password different from your current one.');
        assert.strictEqual(a.passwordProblem({ current: 'a', next: 'longenough', confirm: 'longenough' }), null);
        assert.strictEqual(a.passwordError({ code: 'auth/invalid-credential' }), 'Your current password is not right.');
        const i = script.indexOf('await authService.reauthenticate(cur)');
        assert.ok(i > 0 && i < script.indexOf('await authService.changePassword(next)'));
        assert.match(script, /\$\('password-row'\)\.hidden = !usesPassword/);
        assert.ok(script.indexOf("showToast('Password updated.'") > script.indexOf('await authService.changePassword(next)'));
    });

    await t('the reset link goes through the auth service (the raw SDK is gone)', () => {
        assert.match(script, /await authService\.sendPasswordResetEmail\(user\.email\);/);
        assert.ok(!/firebase-auth\.js|sendPasswordResetEmail\(firebaseAuth/.test(script));
        assert.strictEqual(a.resetError({ code: 'auth/too-many-requests' }), 'Too many requests. Wait a few minutes and try again.');
    });

    await t('sign out asks first and ends the session through the session service', () => {
        assert.match(markup, /id="signout-sheet"[\s\S]*?You won't receive job requests on this device until you sign in again\./);
        assert.match(script, /await sessionService\.logout\(\);[\s\S]*?window\.location\.replace\('login\.html'\);/);
    });

    await t('closing: the server is asked first, the reasons are its own, re-authentication before the request', () => {
        assert.ok(script.indexOf("callable('checkAccountDeletable')") > 0);
        assert.ok(script.indexOf('authService.reauthenticate(') < script.indexOf("callable('requestAccountDeletion')"));
        assert.match(markup, /Type CLOSE to confirm/);
        assert.deepStrictEqual(a.closeBlockers([{ message: 'You still have GHS 5.00 in your wallet.' }, {}]), ['You still have GHS 5.00 in your wallet.']);
        assert.deepStrictEqual(a.closeBlockers({ code: 'functions/failed-precondition', details: { blockers: [{ message: 'A job is in progress.' }] } }), ['A job is in progress.']);
        assert.strictEqual(a.readyToClose({ typed: ' close ', password: '', usesPassword: false }), true);
        assert.strictEqual(a.readyToClose({ typed: 'CLOSE', password: '', usesPassword: true }), false);
        assert.match(read('functions/index.js'), /HttpsError\('failed-precondition', err\.message, \{ blockers: err\.blockers \|\| \[\] \}\)/);
    });

    await t('closing never shows Firebase\'s own error text', () => {
        assert.strictEqual(a.closeError({ code: 'auth/wrong-password', message: 'Firebase: Error (auth/wrong-password).' }), 'That password is not right.');
        assert.strictEqual(a.closeError({ code: 'functions/failed-precondition', message: 'Please confirm it is you' }), 'Your account was not closed. Confirm it is you and try again.');
        assert.strictEqual(a.closeError(new Error('Firebase: Error (auth/internal-error).')), 'Your account was not closed. Try again.');
        assert.ok(!/err\?\.message|err\.message/.test(script), 'no raw error text on the page');
    });

    console.log('\n── The tab: design system, decisions, links ──\n');

    await t('Account is a root tab: the fx tab bar with Account current, and the heartbeat script', () => {
        assert.match(page, /<body class="fx-app">/);
        assert.match(script, /renderTabbar\(document\.getElementById\('tabbar'\), \{ current: 'account' \}\);/);
        assert.match(page, /<script src="js\/artisanFloatingNav\.js"><\/script>/, 'presence on every artisan page');
        assert.ok(!/style="|\.style\./.test(page), 'no inline styles');
        assert.ok(!/design-system\.css|ui-polish\.css|ds-/.test(page), 'no legacy system');
    });

    await t('no Dark mode switch (decision 04: the dark theme waits for Phase 6)', () => {
        assert.ok(!/toggle-theme|Dark mode|pref_theme|applyTheme/.test(page));
    });

    await t('the profile, reputation, notifications, support and legal pages are one tap away', () => {
        for (const href of ['profile.html', 'reputation.html', 'notifications.html', 'support.html', '../shared/legal/terms.html', '../shared/legal/privacy.html', 'wallet.html', 'onboarding.html'])
            assert.match(markup, new RegExp(`href="${href.replace(/\./g, '\\.')}"`), href);
        assert.match(markup, /<a class="fx-row" href="reputation\.html" id="reputation-row">[\s\S]*?<span class="fx-row__title">Reputation<\/span>/);
    });

    await t('every input in a sheet has a label; every sheet is a labelled modal', () => {
        for (const m of markup.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)) {
            if (/^(pw-username|toggle-notif)$/.test(m[1])) continue;
            assert.match(markup, new RegExp(`<label class="fx-field__label" for="${m[1]}">`), m[1]);
        }
        for (const id of ['radius', 'phone', 'password', 'signout', 'close'])
            assert.match(markup, new RegExp(`id="${id}-sheet" hidden>[\\s\\S]*?role="dialog" aria-modal="true" aria-labelledby="${id}-title"`), id);
        assert.match(markup, /<label class="fx-row" for="toggle-notif">[\s\S]*?role="switch"/);
    });

    await t('Profile is on the system too: a screen under Account, the heartbeat, no inline styles or legacy shell', () => {
        const pf = read('artisan-app/profile.html');
        const pfScript = /<script type="module">([\s\S]*?)<\/script>/.exec(pf)[1];
        assert.match(pf, /<body class="fx-app">/);
        assert.match(pf, /<a class="fx-iconbtn" href="settings\.html" aria-label="Back to Account">/);
        assert.match(pfScript, /renderTabbar\(document\.getElementById\('tabbar'\), \{ current: 'account' \}\);/);
        assert.match(pf, /<script src="js\/artisanFloatingNav\.js"><\/script>/);
        assert.ok(!/style="|\.style\.|ds-|pf-sheet-ov|showToast\('[^']*', 'success'\)/.test(pf.replace(/id="pf-[^"]*"/g, '')), 'no legacy system');
        assert.match(pfScript, /\$\('pf-tick'\)\.hidden = status !== 'approved';/, '"Verified" only on the server\'s word');
        assert.ok(!/err\.message|err && err\.message/.test(pfScript), 'no raw error text');
    });

    await t('Support and Notifications are on the system: own tab bar, the heartbeat, no inline handlers, styles or gradient', () => {
        for (const [f, tab] of [['artisan-app/support.html', 'account'], ['artisan-app/notifications.html', 'today']]) {
            const src = read(f);
            const js = /<script type="module">([\s\S]*?)<\/script>/.exec(src)[1];
            assert.match(src, /<body class="fx-app">/, f);
            assert.match(js, new RegExp(`renderTabbar\\(document\\.getElementById\\('tabbar'\\), \\{ current: '${tab}' \\}\\);`), f);
            assert.match(src, /<script src="js\/artisanFloatingNav\.js"><\/script>/, `${f}: the heartbeat`);
            assert.ok(!/onclick=|style="|\.style\.|window\.\w+\s*=\s*(async\s+)?function|gradient|design-system\.css|ui-polish\.css/.test(src), `${f}: legacy`);
        }
        const sup = read('artisan-app/support.html');
        assert.match(sup, /for \(const t of TICKET_TOPICS\)/, 'the topics are the shared list');
        assert.ok(!/Bookings tab|Wallet tab|Complete KYC|Withdraw Earnings/.test(sup), 'no retired screen names in the answers');
    });

    await t('no HandyHub, no review-time promise, no raw-SDK import', () => {
        assert.ok(!/handy\s*hub|business days|firebase-auth\.js/i.test(page));
    });

    console.log(`\naccount: ${passed} passed, ${failed} failed`);
    for (const [n, e] of failures) console.log(`\n✗ ${n}\n  ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n  ')}`);
    process.exit(failed ? 1 : 0);
})();
