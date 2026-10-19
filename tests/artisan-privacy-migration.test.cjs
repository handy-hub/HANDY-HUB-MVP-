'use strict';

/**
 * tests/artisan-privacy-migration.test.cjs — moving artisan identity, payout and
 * home-address data off the world-readable profile, without losing any of it.
 *
 * Run: node tests/artisan-privacy-migration.test.cjs
 *
 * WHAT THIS PROTECTS
 * ──────────────────
 * functions/artisanPrivacy.js moves legacy fields from artisans/{id} into
 * artisans/{id}/private/kyc. A migration over identity data has two ways to do
 * harm — lose a Ghana Card number, or leave it public — and one way to leak:
 * printing values into its own report. These tests cover all three, plus
 * repeat runs, pagination, and who may trigger it.
 *
 * Firestore is an in-memory fake whose runTransaction serialises, matching the
 * other functions harnesses in this directory.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const Module = require('module');

let passed = 0, failed = 0;
const failures = [];
const say = console.log.bind(console);
async function t(name, fn) {
    try { await fn(); passed++; say(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); say(`  FAIL  ${name}\n        ${e.message}`); }
}

// ── In-memory Firestore fake ──────────────────────────────────────────────────
const DEL = Symbol('del');
const DOC_ID = '__name__';

function createFakeFirestore() {
    const store = new Map();
    const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
    const apply = (base, patch) => {
        const out = { ...(base || {}) };
        for (const [k, v] of Object.entries(patch)) {
            if (v && v[DEL]) delete out[k]; else out[k] = clone(v);
        }
        return out;
    };
    const snap = (p) => ({ exists: store.has(p), id: p.split('/').pop(), ref: docRef(p), data: () => clone(store.get(p)) });
    function docRef(p) {
        return {
            path: p, id: p.split('/').pop(),
            async get() { return snap(p); },
            async set(d, o) { store.set(p, o && o.merge ? apply(store.get(p), d) : apply({}, d)); },
            async update(d) { if (!store.has(p)) throw new Error(`update on missing ${p}`); store.set(p, apply(store.get(p), d)); },
            collection(sub) { return collectionRef(`${p}/${sub}`); },
        };
    }
    function query(base, q = { order: null, lim: null, after: null }) {
        const next = (patch) => query(base, { ...q, ...patch });
        return {
            orderBy: (f) => next({ order: f }),
            limit: (n) => next({ lim: n }),
            startAfter: (d) => next({ after: d.id }),
            async get() {
                let docs = [...store.keys()]
                    .filter((k) => k.startsWith(`${base}/`) && !k.slice(base.length + 1).includes('/'))
                    .map(snap);
                if (q.order === DOC_ID) docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
                if (q.after) docs = docs.slice(docs.findIndex((d) => d.id === q.after) + 1);
                if (q.lim != null) docs = docs.slice(0, q.lim);
                return { empty: !docs.length, docs };
            },
        };
    }
    function collectionRef(base) {
        return { ...query(base), doc: (id) => docRef(`${base}/${id || crypto.randomBytes(6).toString('hex')}`) };
    }
    let chain = Promise.resolve();
    function runTransaction(fn) {
        const run = chain.then(async () => {
            const writes = [];
            const txn = {
                get: (r) => r.get(),
                set: (r, d, o) => writes.push(() => r.set(d, o)),
                update: (r, d) => writes.push(() => r.update(d)),
            };
            const out = await fn(txn);
            for (const w of writes) await w();
            return out;
        });
        chain = run.catch(() => {});
        return run;
    }
    return {
        collection: (n) => collectionRef(n), runTransaction,
        _set: (p, v) => store.set(p, clone(v)), _get: (p) => clone(store.get(p)),
        _has: (p) => store.has(p), _size: () => store.size,
        _reset() { store.clear(); chain = Promise.resolve(); },
    };
}

// ── Module interception ───────────────────────────────────────────────────────
const ROOT    = path.join(__dirname, '..');
const FN_DIR  = path.join(ROOT, 'functions');
const FAKE_DB = createFakeFirestore();
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'firebase-admin/app') return { initializeApp: () => {} };
    if (request === 'firebase-admin/firestore') {
        return {
            getFirestore: () => FAKE_DB,
            FieldValue: { delete: () => ({ [DEL]: true }), increment: (n) => n, serverTimestamp: () => new Date().toISOString() },
            FieldPath: { documentId: () => DOC_ID },
            Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
        };
    }
    if (request === 'firebase-admin/messaging') return { getMessaging: () => ({ send: async () => {} }) };
    if (request === 'firebase-admin/auth') return { getAuth: () => ({}) };
    if (request === 'firebase-functions/v2/https') return { HttpsError, onCall: (o, f) => f || o, onRequest: (o, f) => f || o };
    if (request === 'firebase-functions/v2/firestore') return { onDocumentCreated: (o, f) => f, onDocumentUpdated: (o, f) => f, onDocumentWritten: (o, f) => f };
    if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (o, f) => f };
    if (request === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
    if (/(^|\/)notifications$/.test(request)) return { sendNotification: async () => {}, sendArtisanNotification: async () => {} };
    if (/middleware\/rateLimiter$/.test(request)) return { checkRateLimit: async () => {} };
    return origLoad.apply(this, arguments);
};

console.log = () => {}; console.warn = () => {}; console.error = () => {};
const privacy = require(path.join(FN_DIR, 'artisanPrivacy.js'));
const index   = require(path.join(FN_DIR, 'index.js'));
const { ADMIN_EMAILS } = require(path.join(FN_DIR, 'config.js'));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const LEGACY = {
    ghanaCardNumber:  'GHA-123456789-0',
    tin:              'C0012345678',
    dob:              '1990-04-12',
    address:          '12 Example Street, Accra',
    gpsAddress:       'GA-123-4567',
    emergencyContact: { name: 'Ama Mensah', phone: '0240000000' },
    payoutAccount:    { provider: 'mtn', phone: '0241111111', accountName: 'Kofi Boateng' },
    momoPhone:        '0241111111',
};
const PUBLIC = { id: 'a1', name: 'Kofi Boateng', email: 'k@example.com', phone: '0201234567',
                 userType: 'artisan', category: 'plumbing', lat: 5.6, lng: -0.18, rating: 4.5 };

const pub  = (id) => FAKE_DB._get(`artisans/${id}`);
const priv = (id) => FAKE_DB._get(`artisans/${id}/private/kyc`);
const run  = (mode, extra = {}) => privacy.migrateArtisanPrivateData({ mode, ...extra });
const leaked = (report) => Object.values(LEGACY).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v]))
    .filter((v) => JSON.stringify(report).includes(v));

function seedLegacy(id = 'a1', extra = {}) {
    FAKE_DB._set(`artisans/${id}`, { ...PUBLIC, id, ...LEGACY, ...extra });
}

(async () => {

say('\n── The field list cannot drift from the rules ──\n');

await t('artisanPrivacy.js and firestore.rules name exactly the same private fields', async () => {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const m = rules.match(/function artisanPrivateFields\(\)\s*\{\s*return\s*\[([^\]]*)\]/);
    assert.ok(m, 'artisanPrivateFields() not found in firestore.rules');
    const fromRules = m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)).sort();
    assert.deepStrictEqual(fromRules, [...privacy.ARTISAN_PRIVATE_FIELDS].sort());
});

say('\n── Dry run ──\n');

await t('a dry run writes nothing and names the fields it would move', async () => {
    FAKE_DB._reset(); seedLegacy();
    const before = JSON.stringify(pub('a1'));
    const r = await run('dry-run');
    assert.strictEqual(JSON.stringify(pub('a1')), before, 'public profile unchanged');
    assert.ok(!FAKE_DB._has('artisans/a1/private/kyc'), 'no private record created');
    assert.strictEqual(r.affected, 1);
    assert.deepStrictEqual(r.artisans[0].wouldCopy.sort(), Object.keys(LEGACY).sort());
    assert.strictEqual(r.copied, 0);
});

await t('dry run is the default mode', async () => {
    FAKE_DB._reset(); seedLegacy();
    const r = await privacy.migrateArtisanPrivateData();
    assert.strictEqual(r.mode, 'dry-run');
    assert.ok(!FAKE_DB._has('artisans/a1/private/kyc'));
});

await t('an unknown mode is refused', async () => {
    await assert.rejects(() => run('delete-everything'), /mode must be one of/);
});

say('\n── Copy ──\n');

await t('copy fills the private record with every legacy value, exactly', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('copy');
    const p = priv('a1');
    for (const [k, v] of Object.entries(LEGACY)) assert.deepStrictEqual(p[k], v, `${k} copied exactly`);
    assert.strictEqual(p.artisanId, 'a1');
});

await t('copy leaves the public profile untouched', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('copy');
    assert.strictEqual(pub('a1').ghanaCardNumber, LEGACY.ghanaCardNumber, 'copy alone must not strip');
});

await t('copy never overwrites a newer value already in the private record', async () => {
    FAKE_DB._reset(); seedLegacy();
    FAKE_DB._set('artisans/a1/private/kyc', { artisanId: 'a1', tin: 'C0099999999' });
    const r = await run('copy');
    assert.strictEqual(priv('a1').tin, 'C0099999999', 'the newer private value wins');
    assert.deepStrictEqual(r.artisans[0].conflicts, ['tin']);
});

await t('running copy twice changes nothing the second time', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('copy');
    const once = JSON.stringify(priv('a1'));
    const r = await run('copy');
    assert.strictEqual(r.copied, 0);
    const twice = JSON.parse(JSON.stringify(priv('a1')));
    delete twice.updatedAt;
    const o = JSON.parse(once); delete o.updatedAt;
    assert.deepStrictEqual(twice, o);
});

say('\n── Strip ──\n');

await t('strip removes every private field from the public profile and keeps the values', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('copy');
    await run('strip');
    const p = pub('a1');
    for (const k of privacy.ARTISAN_PRIVATE_FIELDS) assert.strictEqual(p[k], undefined, `${k} still public`);
    for (const [k, v] of Object.entries(LEGACY)) assert.deepStrictEqual(priv('a1')[k], v, `${k} lost`);
});

await t('strip without a prior copy is still lossless (copy and strip in one transaction)', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('strip');
    for (const [k, v] of Object.entries(LEGACY)) {
        assert.strictEqual(pub('a1')[k], undefined);
        assert.deepStrictEqual(priv('a1')[k], v);
    }
});

await t('strip keeps the newer private value and still removes the stale public copy', async () => {
    FAKE_DB._reset(); seedLegacy();
    FAKE_DB._set('artisans/a1/private/kyc', { artisanId: 'a1', ghanaCardNumber: 'GHA-NEWER-0' });
    const r = await run('strip');
    assert.strictEqual(priv('a1').ghanaCardNumber, 'GHA-NEWER-0');
    assert.strictEqual(pub('a1').ghanaCardNumber, undefined, 'a stale ID number is still an ID number');
    assert.deepStrictEqual(r.artisans[0].conflicts, ['ghanaCardNumber']);
});

await t('strip leaves every public profile field alone', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('strip');
    for (const [k, v] of Object.entries(PUBLIC)) assert.deepStrictEqual(pub('a1')[k], v, `${k} changed`);
});

await t('running strip again finds nothing to do', async () => {
    FAKE_DB._reset(); seedLegacy();
    await run('strip');
    const r = await run('strip');
    assert.strictEqual(r.affected, 0);
});

await t('an artisan with no private fields is scanned but never touched', async () => {
    FAKE_DB._reset();
    FAKE_DB._set('artisans/clean', { ...PUBLIC, id: 'clean' });
    const r = await run('strip');
    assert.strictEqual(r.scanned, 1);
    assert.strictEqual(r.affected, 0);
    assert.ok(!FAKE_DB._has('artisans/clean/private/kyc'));
});

await t('every artisan is processed across pages', async () => {
    FAKE_DB._reset();
    for (let i = 0; i < 7; i++) seedLegacy(`a${i}`);
    const r = await run('strip', { pageSize: 2 });
    assert.strictEqual(r.scanned, 7);
    assert.strictEqual(r.affected, 7);
    for (let i = 0; i < 7; i++) assert.strictEqual(pub(`a${i}`).ghanaCardNumber, undefined);
});

say('\n── The report never becomes a copy of the data ──\n');

await t('no report, in any mode, contains a private value', async () => {
    for (const mode of ['dry-run', 'copy', 'strip']) {
        FAKE_DB._reset(); seedLegacy();
        const r = await run(mode);
        assert.deepStrictEqual(leaked(r), [], `${mode} report leaked values`);
    }
});

say('\n── Who may run it ──\n');

await t('a non-admin cannot trigger the migration', async () => {
    FAKE_DB._reset(); seedLegacy();
    const err = await index.adminMigrateArtisanPrivateData({ auth: { uid: 'x', token: { email: 'someone@example.com' } }, data: { mode: 'strip' } })
        .then(() => null, (e) => e);
    assert.ok(err && err.code === 'permission-denied', `expected permission-denied, got ${err && err.code}`);
    assert.strictEqual(pub('a1').ghanaCardNumber, LEGACY.ghanaCardNumber, 'nothing moved');
});

await t('an unauthenticated caller cannot trigger it', async () => {
    const err = await index.adminMigrateArtisanPrivateData({ auth: null, data: {} }).then(() => null, (e) => e);
    assert.ok(err && err.code === 'unauthenticated');
});

await t('a super-admin call with no mode is a dry run', async () => {
    FAKE_DB._reset(); seedLegacy();
    const r = await index.adminMigrateArtisanPrivateData({ auth: { uid: 'sa', token: { email: ADMIN_EMAILS[0] } }, data: {} });
    assert.strictEqual(r.mode, 'dry-run');
    assert.strictEqual(pub('a1').ghanaCardNumber, LEGACY.ghanaCardNumber);
});

say(`\nartisan-privacy-migration: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) say(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
})();
