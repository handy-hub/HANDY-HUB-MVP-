'use strict';
/**
 * tests/flow-004-outage.test.cjs — a Firestore outage is not a missing account.
 * (Audit FLOW-004, 28 Oct 2026.)
 *
 * With Firestore unreachable the dashboard's profile listener answered from the
 * (empty) cache with exists:false, and the dashboard took that as "new artisan"
 * and navigated to onboarding.html — an approved artisan saw a blank identity
 * form. The browser reproduction (3/3 attempts) is in
 * tests/e2e/artisan_availability.py; this file pins the rules it depends on.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const db   = code(read('shared/js/backend/providers/firebase/firebaseDatabaseService.js'));
const dash = code(read('artisan-app/dashboard.html'));
const jobs = code(read('artisan-app/jobs.html'));
const guard = code(read('artisan-app/js/utils/artisanAuthGuard.js'));

console.log('\n── A snapshot says where it came from ──\n');

t('document and collection listeners pass fromCache / hasPendingWrites', () => {
    assert.ok(/function snapMeta\(snapshot\)/.test(db));
    assert.ok(/exists: snap\.exists\(\), data: snap\.exists\(\) \? snap\.data\(\) : null, \.\.\.snapMeta\(snap\)/.test(db));
    assert.ok((db.match(/onChange\(snapshot\.docs\.map\(toRecord\), snapMeta\(snapshot\)\)/g) || []).length === 2);
});

console.log('\n── The dashboard never sends an artisan to onboarding on its own guess ──\n');

t('(2)(3) a cache-only "no profile" shows the connection notice, nothing else', () => {
    assert.ok(/if \(snap\.fromCache\) showConnectionNotice\(\);/.test(dash));
});

t('(5) a server-confirmed missing profile is left to the guard (its setup step), not a dashboard redirect', () => {
    const sub = dash.slice(dash.indexOf("subscribeToDocument('artisans', uid"), dash.indexOf("subscribeToDocument('artisans', uid") + 900);
    assert.ok(!/onboarding\.html/.test(sub), 'the profile listener must not navigate');
    assert.ok(/if \(!snap \|\| !snap\.exists\) \{ showOverlay\('setup'\); return; \}/.test(guard), 'the guard still offers setup on a server answer');
});

t('(4) a listener error shows the notice; it is not read as "no profile"', () => {
    assert.ok(/onError: \(\) => showConnectionNotice\(\),/.test(dash));
});

t('(1) a live, approved profile changes nothing: onboarding needs a LIVE profile whose state calls for it', () => {
    assert.ok(/function onboardingWarranted\(\)/.test(dash));
    assert.ok(/return _profileLive && !!_currentArtisan &&/.test(dash));
    assert.ok(/const NEEDS_ONBOARDING = \['', 'draft', 'rejected', 're_verification_required'\];/.test(dash));
});

t('every remaining dashboard route to onboarding is gated on that rule', () => {
    const redirects = [...dash.matchAll(/location\.href = 'onboarding\.html'/g)].map((m) => m.index);
    assert.ok(redirects.length >= 1);
    for (const at of redirects) {
        const before = dash.slice(Math.max(0, at - 260), at);
        assert.ok(/onboardingWarranted\(\)/.test(before), `an onboarding redirect at ${at} is not gated`);
    }
});

t('a cached profile never steers presence or unlocks the availability switch', () => {
    assert.ok(/const cached = fromCache \|\| _profileFromCache;/.test(dash));
    assert.ok(/syncPresence\(data, !cached\);/.test(dash) && /if \(!live\) return;/.test(dash));
    assert.ok(/if \(fromCache\) toggleBtn\.disabled = true;/.test(dash));
});

t('jobs.html Accept sends to onboarding only for a verification state that calls for it', () => {
    assert.ok(/const NEEDS_ONBOARDING = \['', 'draft', 'rejected', 're_verification_required'\];/.test(jobs) && /window\.acceptJob = async function[\s\S]{0,400}if \(onboardingWarranted\(\)\) \{[^}]*onboarding\.html/.test(jobs));
});

t('(6) the guard\'s unauthenticated path is unchanged: no user → login', () => {
    assert.ok(/if \(!user\) \{\s*saveReturnUrl\(\);\s*window\.location\.replace\(LOGIN_URL\);/.test(guard));
});

t('(7) Retry reloads the page — no second set of listeners is ever attached', () => {
    assert.ok(/b\.addEventListener\('click', \(\) => window\.location\.reload\(\)\);/.test(dash));
    assert.ok(/if \(uid === user\.uid\) return;/.test(dash), 'the listener block is wired once per page');
});

console.log(`\nflow-004-outage: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.message}`);
process.exit(failed ? 1 : 0);
