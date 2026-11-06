'use strict';
/**
 * tests/instant-view-lists.test.cjs — a cached LIST is as honest and as private
 * as a cached document (Phase 2, found by tests/e2e/artisan_availability.py).
 *
 * 1. cachedDatabaseService.subscribeToCollection dropped the snapshot metadata
 *    ({ fromCache }), so every page's "an empty answer from the cache is not
 *    known yet, not none" guard (audit NET-001, the liveList wrappers) could
 *    never fire. In an outage the empty cached list was taken as the truth:
 *    Today lost the artisan's job in progress and wrote [] over its cache.
 * 2. instantView's stripFields applied to documents only. A cached list (Today's
 *    active bookings) kept every booking whole in localStorage, the customer's
 *    phone and address included.
 *
 * The real modules run here, with a Map for localStorage.
 */
require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const mod  = (f) => pathToFileURL(path.join(ROOT, 'shared', 'js', 'services', f)).href;

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// A browser-shaped global with a Map-backed localStorage.
const store = new Map();
const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
    clear: () => store.clear(),
};
globalThis.window = { localStorage: storage, sessionStorage: storage, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = storage;

(async () => {
const { createCachedDatabaseService } = await import(mod('cachedDatabaseService.js'));
const { mountInstantView } = await import(mod('instantView.js'));

console.log('\n── The snapshot metadata reaches the page ──\n');

await t('subscribeToCollection forwards { fromCache } with the records', () => {
    const seen = [];
    const inner = { subscribeToCollection: (c, cond, opts, onChange) => { onChange([], { fromCache: true }); onChange([{ id: 'b1', data: {} }], { fromCache: false }); return () => {}; } };
    const db = createCachedDatabaseService(inner);
    db.subscribeToCollection('bookings', [], {}, (records, meta) => seen.push([records.length, meta && meta.fromCache]));
    assert.deepStrictEqual(seen, [[0, true], [1, false]]);
});

await t('so a page guard can tell "empty from the cache" from "none" (Today\'s liveList)', () => {
    const dash = fs.readFileSync(path.join(ROOT, 'artisan-app', 'dashboard.html'), 'utf8');
    assert.match(dash, /const liveList = \(onData\) => \(records, meta\) => \{\s*if \(meta && meta\.fromCache && !records\.length\) \{ showConnectionNotice\(\); return; \}/);
    const painted = [];
    let notice = 0;
    const liveList = (onData) => (records, meta) => { if (meta && meta.fromCache && !records.length) { notice++; return; } onData(records); };
    const inner = { subscribeToCollection: (c, cond, opts, onChange) => { onChange([], { fromCache: true }); return () => {}; } };
    createCachedDatabaseService(inner).subscribeToCollection('bookings', [], {}, liveList((r) => painted.push(r)));
    assert.strictEqual(notice, 1, 'the outage is said');
    assert.deepStrictEqual(painted, [], 'and the empty cache answer is not painted over what is known');
});

console.log('\n── A cached list keeps out what the screen does not show ──\n');

const sub = (records) => (_uid, onData) => { onData(records); return () => {}; };
const cached = (key) => {
    const k = [...store.keys()].find((x) => x.includes(key));
    return k ? JSON.parse(store.get(k)) : null;
};

await t('stripFields removes the fields from every record of a list', () => {
    store.clear();
    store.set('hh_last_session_uid', 'u1');
    const recs = [{ id: 'b1', data: { status: 'en_route', customerPhone: '+233201234567', address: '12 Ring Road', lat: 5.6, calloutPaid: true } }];
    const view = mountInstantView({ key: 'list-test', version: 1, render: () => {}, subscribe: sub(recs), stripFields: ['customerPhone', 'address', 'lat'] });
    const c = cached('list-test');
    assert.ok(c, 'written');
    const json = JSON.stringify(c);
    for (const leak of ['+233201234567', 'Ring Road', '"lat"']) assert.ok(!json.includes(leak), `${leak} cached: ${json}`);
    assert.ok(json.includes('"status":"en_route"') && json.includes('"calloutPaid":true'), 'what the screen needs is kept');
    assert.strictEqual(recs[0].data.customerPhone, '+233201234567', 'the live data handed to render is untouched');
    view.destroy();
});

await t('documents are stripped exactly as before', () => {
    store.clear();
    store.set('hh_last_session_uid', 'u1');
    const view = mountInstantView({ key: 'doc-test', version: 1, render: () => {}, subscribe: sub({ name: 'K', walletBalance: 90 }), stripFields: ['walletBalance'] });
    const json = JSON.stringify(cached('doc-test'));
    assert.ok(json.includes('"name":"K"') && !json.includes('walletBalance'), json);
    view.destroy();
});

await t("Today's offer and booking caches strip identity, contact and location", () => {
    const dash = fs.readFileSync(path.join(ROOT, 'artisan-app', 'dashboard.html'), 'utf8');
    assert.match(dash, /key: 'artisan-dashboard-offers',[\s\S]*?stripFields: \['customerFirstName', 'lat', 'lng'\],/);
    const active = dash.slice(dash.indexOf("key: 'artisan-dashboard-active'"));
    const fields = active.match(/stripFields: \[([\s\S]*?)\]/)[1];
    for (const f of ['customerPhone', 'customerName', 'customerFirstName', 'customerEmail', 'address', 'lat', 'lng', 'notes']) {
        assert.ok(fields.includes(`'${f}'`), `${f} is cached`);
    }
});

console.log(`\ninstant-view-lists: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) console.log(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
