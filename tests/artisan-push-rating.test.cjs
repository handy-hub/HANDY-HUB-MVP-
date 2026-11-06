'use strict';
/**
 * artisan-push-rating.test.cjs — two artisan screens that said something the
 * data did not support. (Phase 0 IX-01, IX-02.) Each runs the page's own code.
 *
 * IX-01  Settings showed the push switch ON beside "Blocked by this browser".
 *        The switch now shows whether pushes reach THIS device; the saved
 *        preference (which governs the artisan's other devices) is untouched.
 * IX-02  Profile and dashboard rendered the rating without resolveRating():
 *        the dashboard showed "0.0" to an artisan nobody had rated, and the
 *        profile showed a score with no reviews behind it.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const page = (f) => fs.readFileSync(path.join(ROOT, 'artisan-app', f), 'utf8').replace(/\r\n/g, '\n');

function stripEsm(src) {
    return src
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
}
// eslint-disable-next-line no-new-func
const { resolveRating } = new Function(`${stripEsm(fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', 'bookingTruth.js'), 'utf8'))}\nreturn { resolveRating };`)();

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

(async () => {
console.log('\n── IX-01 · the push switch says what this device will receive ──\n');

const settings = page('settings.html');
/** settings.html's own push block, from DEVICE_LINE to renderPush, over stubs. */
function pushBlock({ saved, device }) {
    const start = settings.indexOf('const DEVICE_LINE = {');
    const end   = settings.indexOf("notifToggle.addEventListener('change'", start);
    assert.ok(start > 0 && end > start, 'push block not found');
    const src = settings.slice(start, end)
        .replace("await import('../shared/js/services/pushNotificationService.js')", 'pushSvc');
    const notifToggle = { checked: null };
    const notifSub    = { textContent: '' };
    const state = { notificationPreferences: saved === undefined ? undefined : { push: saved } };
    const before = JSON.stringify(state);
    // eslint-disable-next-line no-new-func
    const run = new Function('notifToggle', 'notifSub', 'state', 'pushSvc', `
        let pushPref = true, pushSaving = false;
        const savedPush = () => !(state.notificationPreferences && state.notificationPreferences.push === false);
        ${src}
        return { renderPush, describeDevice };`)(notifToggle, notifSub, state, { getPushState: () => device });
    return { run, notifToggle, notifSub, unchanged: () => JSON.stringify(state) === before };
}
const settle = () => new Promise((r) => setImmediate(r));

await t('preference on, browser blocked: the switch is off and says why', async () => {
    const p = pushBlock({ saved: true, device: 'blocked' });
    p.run.renderPush(); await settle();
    assert.strictEqual(p.notifToggle.checked, false);
    assert.match(p.notifSub.textContent, /^Blocked by this browser\./);
    assert.ok(p.unchanged(), 'the saved preference must not change');
});
await t('preference on, browser cannot receive push: off, with the reason', async () => {
    const p = pushBlock({ saved: true, device: 'unsupported' });
    p.run.renderPush(); await settle();
    assert.strictEqual(p.notifToggle.checked, false);
    assert.match(p.notifSub.textContent, /can't receive push/);
});
await t('preference on, push working: on', async () => {
    const p = pushBlock({ saved: true, device: 'on' });
    p.run.renderPush(); await settle();
    assert.strictEqual(p.notifToggle.checked, true);
    assert.strictEqual(p.notifSub.textContent, 'On for this device.');
});
await t('states this device can still recover from keep the switch on (not asked yet, failed, checking)', async () => {
    for (const device of ['off', 'failed', 'pending']) {
        const p = pushBlock({ saved: undefined, device });
        p.run.renderPush(); await settle();
        assert.strictEqual(p.notifToggle.checked, true, device);
    }
});
await t('preference off: off, whatever the device', async () => {
    for (const device of ['on', 'blocked']) {
        const p = pushBlock({ saved: false, device });
        p.run.renderPush(); await settle();
        assert.strictEqual(p.notifToggle.checked, false, device);
        assert.match(p.notifSub.textContent, /^Off\./, device);
    }
});
await t('after a save, the switch is set from the device state, not from what was tapped', () => {
    const handler = settings.slice(settings.indexOf("notifToggle.addEventListener('change'"), settings.indexOf("window.addEventListener('fx:push-state'"));
    assert.match(handler, /pushPref = want;[\s\S]*await describeDevice\(\);/);
});

console.log('\n── IX-02 · a rating only with reviews behind it ──\n');

const profile = page('profile.html');
function profileRating(d) {
    const src = profile.slice(profile.indexOf('const rated = resolveRating(d);'), profile.indexOf("$('pf-jobs')"));
    const els = { 'pf-rating': { textContent: '' }, 'pf-rating-lbl': { textContent: '' } };
    // eslint-disable-next-line no-new-func
    new Function('d', '$', 'resolveRating', src)(d, (id) => els[id], resolveRating);
    return [els['pf-rating'].textContent, els['pf-rating-lbl'].textContent];
}
await t('profile: a score with no reviews behind it is not shown', () => {
    assert.deepStrictEqual(profileRating({ rating: 4.6, reviewCount: 0 }), ['—', 'No reviews yet']);
    assert.deepStrictEqual(profileRating({ rating: 4.6, reviewCount: null }), ['—', 'No reviews yet']);
    assert.deepStrictEqual(profileRating({}), ['—', 'No reviews yet']);
});
await t('profile: reviews with an unusable score say so, never a number', () => {
    assert.deepStrictEqual(profileRating({ rating: 0, reviewCount: 2 }), ['—', 'No rating available']);
});
await t('profile: a reviewed artisan shows the average and the count', () => {
    assert.deepStrictEqual(profileRating({ rating: 4.56, reviewCount: 3 }), ['★ 4.6', '3 reviews']);
    assert.deepStrictEqual(profileRating({ rating: 5, reviewCount: 1 }), ['★ 5.0', '1 review']);
});

// Phase 2: Today (dashboard.html) no longer shows a rating at all — its two
// rating slots (stats row, performance card) went with the rebuild, so no
// score, real or "0.0", can appear there. The profile above is the screen that
// shows it, through resolveRating; Reviews and Performance stay one tap away.
const dashboard = page('dashboard.html') + page('js/today.js');
await t('Today: no rating slot and no rating figure, so no "0.0" for an artisan nobody has rated', () => {
    assert.doesNotMatch(dashboard, /id="(stat|perf)-rating"|statRating|\.rating\b|reviewCount|toFixed\(1\)/);
});
await t('Today: Reviews and Performance are one tap away', () => {
    assert.match(page('dashboard.html'), /<a class="fx-row" href="reviews\.html">/);
    assert.match(page('dashboard.html'), /<a class="fx-row" href="performance\.html">/);
});

console.log(`\nartisan-push-rating: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
