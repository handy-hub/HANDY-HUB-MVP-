'use strict';
/**
 * tests/dispatch-liveness.test.cjs — an artisan seen recently in the app ranks
 * above one who is merely available; nobody is excluded; and a heartbeat costs
 * at most one index write per 5-minute bucket. (Follow-up to FLOW-001/002.)
 *
 * The page-lifecycle "offline" writes FLOW-001 removed were, unreliably, the
 * only thing that ever told dispatch an artisan had gone. Availability now
 * stays the artisan's choice (push reaches a closed app), and liveness is a
 * separate ranking signal: artisan_index.lastHeartbeatMs, bucketed.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
const fake = require('./support/fake-firebase.cjs').install();
const artisanIndex = require(path.join(FN, 'artisanIndex.js'));
const dispatch     = require(path.join(FN, 'dispatch.js'));
const { geohashForLocation } = createRequire(path.join(FN, 'package.json'))('geofire-common');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}`); }
}

const BUCKET = artisanIndex.LIVENESS_BUCKET_MS;
const iso = (ms) => new Date(ms).toISOString();
const P = { lat: 5.6037, lng: -0.1870 };

(async () => {

console.log('\n── The index carries a bucketed heartbeat ──\n');

await t('lastHeartbeat (ISO) becomes lastHeartbeatMs rounded down to 5 minutes', () => {
    const at = Date.parse('2026-10-28T10:07:42.000Z');
    const doc = artisanIndex._buildIndexDoc('a1', { lastHeartbeat: iso(at) }, P.lat, P.lng);
    assert.strictEqual(doc.lastHeartbeatMs, Date.parse('2026-10-28T10:05:00.000Z'));
    assert.strictEqual(artisanIndex._buildIndexDoc('a1', {}, P.lat, P.lng).lastHeartbeatMs, null);
});

console.log('\n── Cost: a heartbeat writes the index at most once per bucket ──\n');

await t('10 heartbeats inside one 5-minute bucket → 1 index write (the first), 0 after', async () => {
    fake.db._reset();
    fake.db._set('artisans/a1/private/location', { lat: P.lat, lng: P.lng });
    const t0 = Math.floor(Date.parse('2026-10-28T10:00:00.000Z') / BUCKET) * BUCKET;
    const base = { userType: 'artisan', status: 'active', verificationStatus: 'approved', isAvailable: true, isOnline: true, category: 'plumbing' };
    let writes = 0;
    let before = null;
    for (let i = 0; i < 10; i++) {
        const after = { ...base, lastHeartbeat: iso(t0 + i * 25_000), presenceUpdatedAt: iso(t0 + i * 25_000), updatedAt: iso(t0 + i * 25_000) };
        const prevIndex = JSON.stringify(fake.db._get('artisan_index/a1') || null);
        await artisanIndex.syncArtisanIndex({
            params: { artisanId: 'a1' },
            data: {
                before: { exists: !!before, data: () => before },
                after:  { exists: true, data: () => after },
            },
        });
        if (JSON.stringify(fake.db._get('artisan_index/a1') || null) !== prevIndex) writes++;
        before = after;
    }
    assert.strictEqual(writes, 1, `index written ${writes} times`);
});

await t('crossing into the next bucket writes again; a real change writes at once', async () => {
    const t0 = Math.floor(Date.parse('2026-10-28T10:00:00.000Z') / BUCKET) * BUCKET;
    const base = { userType: 'artisan', status: 'active', verificationStatus: 'approved', isAvailable: true, isOnline: true };
    const a = { ...base, lastHeartbeat: iso(t0 + 1000) };
    assert.strictEqual(artisanIndex._presenceOnlyNoop(a, { ...a, lastHeartbeat: iso(t0 + 200_000) }), true);
    assert.strictEqual(artisanIndex._presenceOnlyNoop(a, { ...a, lastHeartbeat: iso(t0 + BUCKET + 1000) }), false, 'next bucket');
    assert.strictEqual(artisanIndex._presenceOnlyNoop(a, { ...a, isAvailable: false }), false, 'Go Offline always syncs');
    assert.strictEqual(artisanIndex._presenceOnlyNoop(a, { ...a, lat: 5.61 }), false, 'a move always syncs');
});

console.log('\n── Ranking, not exclusion ──\n');

await t('online points need a recent heartbeat; availability is untouched', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const c = [
        { id: 'fresh', isAvailable: true, isOnline: true, lastHeartbeatMs: now - 5 * 60_000 },
        { id: 'stale', isAvailable: true, isOnline: true, lastHeartbeatMs: now - 3 * 3600_000 },
        { id: 'never', isAvailable: true, isOnline: true, lastHeartbeatMs: null },
        { id: 'off',   isAvailable: true, isOnline: false, lastHeartbeatMs: now },
    ];
    artisanIndex.applyLiveness(c, now);
    assert.deepStrictEqual(c.map((x) => x.isOnline), [true, false, false, false]);
    assert.ok(c.every((x) => x.isAvailable === true), 'nobody loses availability');
    assert.strictEqual(c.length, 4, 'nobody is removed');
});

function seedTwo(now) {
    fake.db._reset();
    fake.db._set('bookings/b1', {
        customerId: 'c1', serviceType: 'plumbing', status: 'pending', track: 'standard', type: 'standard',
        lat: P.lat, lng: P.lng, calloutFee: 60, createdAt: iso(now - 5 * 60_000),
    });
    const idx = (id, hb) => ({
        artisanId: id, geohash: geohashForLocation([P.lat, P.lng]), lat: P.lat, lng: P.lng, skills: ['plumbing'],
        isAvailable: true, isOnline: true, status: 'active', verificationStatus: 'approved',
        rating: 4.5, reviewCount: 0, workRadius: 20, name: id, lastHeartbeatMs: hb,
    });
    // `stale` sorts first by id, so it would win a tie — liveness must break it.
    fake.db._set('artisan_index/a_stale', idx('a_stale', now - 6 * 3600_000));
    fake.db._set('artisan_index/b_fresh', idx('b_fresh', now - 60_000));
    for (const id of ['a_stale', 'b_fresh']) fake.db._set(`artisans/${id}`, { userType: 'artisan', status: 'active', verificationStatus: 'approved', name: id });
}

await t('dispatch offers the job to the recently-seen artisan first', async () => {
    const now = Date.now();
    seedTwo(now);
    await dispatch.dispatchRound('b1');
    assert.strictEqual(fake.db._get('job_offers/b1').artisanId, 'b_fresh');
});

await t('the stale artisan is still offered the job when the fresh one is gone (not excluded)', async () => {
    const now = Date.now();
    seedTwo(now);
    fake.db._set('artisan_index/b_fresh', { ...fake.db._get('artisan_index/b_fresh'), isAvailable: false });
    await dispatch.dispatchRound('b1');
    assert.strictEqual(fake.db._get('job_offers/b1').artisanId, 'a_stale');
});

console.log('\n── An artisan already on a job still receives offers (decision Q3, 2026-11-06) ──\n');

// Product decision: offers keep arriving while an artisan is en route or on site,
// with the full response window. Phase 0 (WF-04) found this was the behaviour;
// it is now the policy, and this holds it. Changing it is a product decision,
// not a fix.
for (const status of ['en_route', 'in_progress']) {
    await t(`an artisan whose other booking is ${status} is offered the new job, full window`, async () => {
        const now = Date.now();
        seedTwo(now);
        fake.db._set('artisan_index/a_stale', { ...fake.db._get('artisan_index/a_stale'), isAvailable: false });
        fake.db._set('bookings/onsite', { customerId: 'c2', artisanId: 'b_fresh', serviceType: 'plumbing', status, track: 'inspection', createdAt: iso(now - 3600_000) });
        await dispatch.dispatchRound('b1');
        const offer = fake.db._get('job_offers/b1');
        assert.ok(offer, 'no offer was made');
        assert.strictEqual(offer.artisanId, 'b_fresh');
        assert.ok(offer.expiresAtMs - now >= 170_000, `window ${Math.round((offer.expiresAtMs - now) / 1000)} s`);
    });
}

console.log('\n── The app writes the heartbeat at most every 5 minutes, on every page ──\n');

const presence = fs.readFileSync(path.join(ROOT, 'shared/js/services/presenceService.js'), 'utf8');
const nav      = fs.readFileSync(path.join(ROOT, 'artisan-app/js/artisanFloatingNav.js'), 'utf8');

await t('presence throttles the heartbeat write to the server bucket, across page loads', () => {
    assert.match(presence, /const HEARTBEAT_WRITE_MS\s+= 5 \* 60 \* 1000;/);
    assert.match(presence, /if \(nowTime - previous < HEARTBEAT_WRITE_MS\) return;/);
    assert.match(presence, /sessionStorage\.setItem\(HEARTBEAT_MARK/);
    assert.strictEqual(5 * 60 * 1000, BUCKET, 'client throttle and server bucket agree');
});

await t('the nav keeps a heartbeat on every artisan page, without location tracking', () => {
    assert.match(nav, /p\.ensurePresence\(user\.uid, c\.services\.databaseService,/);
    assert.match(presence, /startPresence\(uid, databaseService, available, \{ trackLocation: false \}\)/);
    assert.match(presence, /if \(_options && _options\.trackLocation === false\) return false;/);
});

await t('every signed-in artisan screen carries a heartbeat, the job screen included', () => {
    // Today runs presence itself (with location); onboarding is for accounts
    // that cannot be dispatched yet. Every other guarded screen loads the script.
    const dir = path.join(ROOT, 'artisan-app');
    const missing = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.html'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        if (!/requireArtisanAuth\(/.test(src) || f === 'onboarding.html') continue;
        const own = f === 'dashboard.html' && /startPresence\(/.test(src);
        if (!own && !/<script src="js\/artisanFloatingNav\.js"><\/script>/.test(src)) missing.push(f);
    }
    assert.deepStrictEqual(missing, []);
    assert.match(fs.readFileSync(path.join(dir, 'job.html'), 'utf8'), /<script src="js\/artisanFloatingNav\.js"><\/script>/);
});

console.log(`\ndispatch-liveness: ${passed} passed, ${failed} failed`);
for (const [name, e] of failures) console.log(`\n  ✗ ${name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e}`);
process.exit(failed ? 1 : 0);
})();
