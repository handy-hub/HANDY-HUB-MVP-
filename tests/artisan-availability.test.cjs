'use strict';
/**
 * tests/artisan-availability.test.cjs — an artisan's availability changes only
 * when they change it. (Audit FLOW-001 / FLOW-002 / FLOW-008, 28 Oct 2026.)
 *
 *   FLOW-001  Opening Wallet, Profile or Settings set artisans/{uid} and
 *             artisan_index isAvailable:false — the presence service wrote
 *             "offline" on pagehide, so the artisan left dispatch by browsing.
 *   FLOW-002  "Go Offline" was undone by the next dashboard visit — the
 *             dashboard started presence with `true`, which wrote "online".
 *   FLOW-008  The dashboard card and the nav toggle each kept their own idea of
 *             the state and disagreed.
 *
 * The browser half (navigation, reload, network loss against the emulators) is
 * tests/e2e/artisan_availability.py. This file proves the pieces both rely on.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

/** Load a pure ES module's exports without an ESM loader (it has no imports). */
function loadEsm(rel, names) {
    const src = read(rel)
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    // eslint-disable-next-line no-new-func
    return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

const AV = loadEsm('shared/js/domain/availability.js',
    ['availabilityBlocker', 'storedAvailability', 'createAvailabilityQueue', 'AVAILABILITY_FIELDS']);

/** A promise whose resolution the test controls (a slow GPS fix). */
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

/** Strip comments so structural checks read code, not prose about it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
/** The body of `function name(...) {...}` (brace-matched), from comment-free source. */
function fnBody(src, name) {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
    assert.ok(m, `function ${name} not found`);
    // Skip the parameter list (it may hold a destructuring `{`).
    let p = m.index + m[0].length - 1, parens = 0;
    for (; p < src.length; p++) {
        if (src[p] === '(') parens++;
        else if (src[p] === ')' && --parens === 0) break;
    }
    let i = src.indexOf('{', p), depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

(async () => {

console.log('\n── Who may go online (eligibility mirrors dispatch) ──\n');

await t('an approved, active artisan may go online', () => {
    assert.strictEqual(AV.availabilityBlocker({ status: 'active', verificationStatus: 'approved' }), null);
});

await t('an artisan under review, unverified, rejected, suspended or unloaded may not — each with its reason', () => {
    const r = (a) => AV.availabilityBlocker(a) && AV.availabilityBlocker(a).reason;
    assert.strictEqual(r({ status: 'pending', verificationStatus: 'pending_review' }), 'under_review');
    assert.strictEqual(r({ status: 'pending', verificationStatus: 'submitted' }), 'under_review');
    assert.strictEqual(r({ status: 'pending', verificationStatus: 'draft' }), 'unverified');
    assert.strictEqual(r({ status: 'active', verificationStatus: 'rejected' }), 'unverified');
    assert.strictEqual(r({ status: 'suspended', verificationStatus: 'approved' }), 'suspended');
    assert.strictEqual(r({ status: 'banned', verificationStatus: 'approved' }), 'suspended');
    assert.strictEqual(r(null), 'unknown');
});

await t('the stored choice is strict: a missing field is "not available"', () => {
    assert.strictEqual(AV.storedAvailability({ isAvailable: true }), true);
    assert.strictEqual(AV.storedAvailability({ isAvailable: false }), false);
    assert.strictEqual(AV.storedAvailability({}), false);
    assert.strictEqual(AV.storedAvailability(null), false);
});

console.log('\n── FLOW-002 · an explicit choice is saved in order, and the last tap wins ──\n');

await t('Go Online then Go Offline quickly: the slow GPS fix cannot bring "online" back', async () => {
    const writes = [];
    const gps = deferred();
    const q = AV.createAvailabilityQueue({ write: async (a) => { writes.push(a); }, acquirePosition: () => gps.promise });
    const on  = q.request(true);
    const off = q.request(false);
    await tick();
    gps.resolve({ latitude: 5.6, longitude: -0.19, accuracy: 10 });   // the fix lands AFTER the offline tap
    const [rOn, rOff] = await Promise.all([on, off]);
    assert.deepStrictEqual(writes, [false], 'only the latest choice is written');
    assert.strictEqual(rOn.superseded, true);
    assert.strictEqual(rOff.ok, true);
});

await t('Go Offline, then later Go Online: both are written, in order', async () => {
    const writes = [];
    const q = AV.createAvailabilityQueue({ write: async (a) => { writes.push(a); }, acquirePosition: async () => ({}) });
    await q.request(false);
    await q.request(true);
    assert.deepStrictEqual(writes, [false, true]);
});

await t('two taps queued before either is saved: only the later one is written (no stale overwrite)', async () => {
    const writes = [];
    const q = AV.createAvailabilityQueue({ write: async (a) => { writes.push(a); }, acquirePosition: async () => ({}) });
    const [first, second] = await Promise.all([q.request(false), q.request(true)]);
    assert.deepStrictEqual(writes, [true]);
    assert.strictEqual(first.superseded, true);
    assert.strictEqual(second.ok, true);
});

await t('rapid on / off / on ends online with a single write', async () => {
    const writes = [];
    const q = AV.createAvailabilityQueue({ write: async (a) => { writes.push(a); }, acquirePosition: async () => ({}) });
    const r = await Promise.all([q.request(true), q.request(false), q.request(true)]);
    assert.deepStrictEqual(writes, [true]);
    assert.deepStrictEqual(r.map((x) => x.superseded), [true, true, false]);
});

await t('no GPS fix: going online fails, nothing is written, and the artisan stays as they were', async () => {
    const writes = [];
    const q = AV.createAvailabilityQueue({
        write: async (a) => { writes.push(a); },
        acquirePosition: async () => { throw new Error('Location permission was denied.'); },
    });
    await assert.rejects(q.request(true), /permission was denied/);
    assert.deepStrictEqual(writes, []);
});

await t('a failed save is reported, and the next choice still goes through (retry)', async () => {
    let fail = true;
    const writes = [];
    const q = AV.createAvailabilityQueue({
        write: async (a) => { if (fail) { fail = false; throw new Error('unavailable'); } writes.push(a); },
        acquirePosition: async () => ({}),
    });
    await assert.rejects(q.request(false), /unavailable/);
    const r = await q.request(false);
    assert.ok(r.ok);
    assert.deepStrictEqual(writes, [false]);
});

await t('a save not yet confirmed by the server (offline) is reported as queued, not as a hang', async () => {
    const q = AV.createAvailabilityQueue({ write: async () => ({ queued: true }), acquirePosition: async () => ({}) });
    const r = await q.request(false);
    assert.deepStrictEqual([r.ok, r.queued], [true, true]);
    const q2 = AV.createAvailabilityQueue({ write: async () => undefined, acquirePosition: async () => ({}) });
    assert.strictEqual((await q2.request(false)).queued, false);
});

await t('presence bounds the GPS wait and the write acknowledgement, so the switch always settles', () => {
    const src = read('shared/js/services/presenceService.js');
    assert.ok(/return _within\(_rawPosition\(\), GPS_GUARD_MS,/.test(src));
    assert.ok(/await _within\(ack\.then\(\(\) => true\), WRITE_GUARD_MS, \(\) => false\)/.test(src));
});

await t('busy is true while a choice is being saved, and false after', async () => {
    const gate = deferred();
    const q = AV.createAvailabilityQueue({ write: () => gate.promise, acquirePosition: async () => ({}) });
    const p = q.request(false);
    await tick();
    assert.strictEqual(q.busy, true);
    gate.resolve();
    await p;
    assert.strictEqual(q.busy, false);
});

console.log('\n── FLOW-001 · nothing but the explicit switch writes availability ──\n');

const presence = code(read('shared/js/services/presenceService.js'));

await t('page lifecycle, network and heartbeat handlers never write isAvailable or isOnline', () => {
    for (const fn of ['_onPageHide', '_onVisibilityChange', '_onNetworkOffline', '_onNetworkOnline',
                      '_heartbeat', '_writeLocation', '_handlePositionUpdate', 'startPresence',
                      'syncAvailability', 'stopPresence', '_retrack']) {
        const body = fnBody(presence, fn);
        assert.ok(!/isAvailable|isOnline/.test(body), `${fn} must not touch availability`);
    }
});

await t('the only availability write in presence is the explicit queue', () => {
    // Every `isAvailable:` (the profile write and the guard-session patch that
    // mirrors it) must sit inside the queue's write callback.
    const queueAt  = presence.indexOf('createAvailabilityQueue({');
    const queueEnd = presence.indexOf('let _pendingUid', queueAt);
    assert.ok(queueAt > -1 && queueEnd > queueAt, 'availability queue not found');
    const all = [...presence.matchAll(/isAvailable\s*:/g)].map((m) => m.index);
    assert.ok(all.length >= 1, 'no availability write at all');
    for (const at of all) assert.ok(at > queueAt && at < queueEnd, 'an availability write outside the explicit queue');
    assert.strictEqual((presence.match(/updatePresenceAndLocation\(uid, \{\s*isOnline:\s*available,\s*isAvailable:\s*available/g) || []).length, 1);
});

await t('presence no longer listens for beforeunload, and pagehide only stops GPS', () => {
    assert.ok(!/beforeunload/.test(presence), 'beforeunload must not be handled');
    assert.ok(/function _onPageHide\(\)\s*\{\s*_stopWatcher\(\);\s*\}/.test(presence));
});

await t('the repository writes availability only when it is passed (no default from isOnline)', () => {
    const repo = code(read('shared/js/data/repositories/artisanRepository.js'));
    const body = fnBody(repo.replace('async updatePresenceAndLocation(', 'function updatePresenceAndLocation('), 'updatePresenceAndLocation');
    assert.ok(/if \(isAvailable !== undefined\)\s*payload\.isAvailable/.test(body));
    assert.ok(/if \(isOnline !== undefined\)\s*payload\.isOnline/.test(body));
    assert.ok(!/isAvailable:\s*isAvailable !== undefined \?/.test(body), 'the old isOnline fallback is gone');
});

await t('the dashboard starts presence from the stored choice, never from `true`', () => {
    const dash = code(read('artisan-app/dashboard.html'));
    assert.ok(!/startPresence\([^)]*,\s*true\s*,/.test(dash), 'no startPresence(..., true, ...)');
    assert.ok(/startPresence\(uid, databaseService, available, presenceOptions\)/.test(dash));
    assert.ok(!/updatePresenceAndLocation\(/.test(dash), 'the dashboard no longer writes availability on a GPS error');
});

await t('jobs.html starts presence from the stored choice too', () => {
    const jobs = code(read('artisan-app/jobs.html'));
    assert.ok(!/startPresence\([^)]*,\s*true\s*,/.test(jobs));
    assert.ok(/storedAvailability\(a\)/.test(jobs));
});

console.log('\n── FLOW-008 · one source of truth for both controls ──\n');

await t('the nav toggle follows the profile live and switches through setAvailability', () => {
    const nav = code(read('artisan-app/js/artisanFloatingNav.js'));
    assert.ok(/subscribeToDocument\('artisans'/.test(nav), 'nav subscribes to the live profile');
    assert.ok(/presence\.setAvailability\(_uid, next, \{ artisan: _artisan \}\)/.test(nav));
    assert.ok(!/updateDocument\('artisans'/.test(nav), 'nav no longer writes the profile itself');
});

await t('the dashboard card switches through the same setAvailability', () => {
    const dash = code(read('artisan-app/dashboard.html'));
    assert.ok(/setAvailability\(uid, next, \{ artisan: _currentArtisan \}\)/.test(dash));
    assert.ok(!/setOnlineState\(/.test(dash));
});

console.log(`\nartisan-availability: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
