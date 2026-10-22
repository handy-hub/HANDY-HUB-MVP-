'use strict';

/**
 * tests/callable-groups.test.cjs — group routers answer exactly as the
 * functions they stand in for, and the apps fall back only when it is safe.
 *
 * Run: node tests/callable-groups.test.cjs
 *
 *   SERVER  bookingActions / walletActions (functions/callableGroups.js) run the
 *           action's own handler: for every grouped action, the router and the
 *           per-action function give the same answer to the same request. The
 *           router refuses the unauthenticated and the unknown before anything.
 *   SDK     the routers resolve the real firebase-functions `.run` of each
 *           member (a child process loads functions/index.js without fakes).
 *   CLIENT  shared/js/services/callable.js sends a grouped action to its router
 *           and calls the action directly ONLY when the router never ran (404,
 *           a platform 403, an unknown action). A handler's own error is the
 *           answer and is never retried — retrying could pay twice.
 *   SOURCE  no app calls a grouped action by name any more.
 *
 * The REAL functions/index.js handlers run against tests/support/fake-firebase.cjs.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');

const fake = require('./support/fake-firebase.cjs').install();
const ROOT = path.join(__dirname, '..');
const FN   = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'lamax-4fd82';

const fns       = require(path.join(FN, 'index.js'));
const jobOffers = require(path.join(FN, 'jobOffers.js'));
const { createGroupRouter } = require(path.join(FN, 'callableGroups.js'));
const { CALLABLE_GROUPS, groupOf } = require(path.join(FN, 'shared', 'callableGroups.js'));

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Outcome of a handler call, comparable across the two paths. */
async function outcome(promiseFn) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'timeout' })), 5000));
    try { return { ok: true, value: await Promise.race([promiseFn(), timeout]) }; }
    catch (e) { return { ok: false, code: e.code || null, message: e.message, details: e.details ?? null }; }
}
const AUTH = { uid: 'cust_g1', token: { email: 'c@example.com', email_verified: true } };

(async () => {
console.log('\n── SERVER · a router answers exactly as the function it stands in for ──\n');

const GROUPS = Object.keys(CALLABLE_GROUPS);

await t('one router per group, each listing only exported callables, no action in two groups', () => {
    assert.deepStrictEqual(GROUPS.sort(), ['bookingActions', 'walletActions']);
    const all = Object.values(CALLABLE_GROUPS).flat();
    assert.strictEqual(new Set(all).size, all.length);
    for (const g of GROUPS) assert.strictEqual(typeof fns[g], 'function', `${g} not exported`);
    for (const a of all) {
        assert.strictEqual(typeof fns[a], 'function', `${a} not exported`);
        assert.ok(groupOf(a), a);
    }
    assert.strictEqual(groupOf('artisanAccount'), null);
});

for (const [group, actions] of Object.entries(CALLABLE_GROUPS)) {
    for (const action of actions) {
        for (const [label, data] of [['empty input', {}], ['no input', null]]) {
            await t(`${group} · ${action} (${label}) = ${action} called directly`, async () => {
                fake.db._reset();
                const direct = await outcome(() => fns[action]({ auth: AUTH, data }));
                fake.db._reset();
                const routed = await outcome(() => fns[group]({ auth: AUTH, data: { action, payload: data } }));
                assert.notStrictEqual(direct.code, 'timeout', 'direct call hung');
                assert.deepStrictEqual(routed, direct);
            });
        }
    }
}

await t('a real accept through bookingActions makes the artisan the booking\'s artisan', async () => {
    fake.db._reset();
    fake.db._set('artisans/art_g1', { userType: 'artisan', status: 'active', verificationStatus: 'approved' });
    fake.db._set('bookings/bk_g1', { customerId: 'cust_g1', status: 'pending', currentArtisanId: 'art_g1', artisanId: null,
        dispatchStatus: 'dispatched', currentDispatchRound: 1, serviceType: 'plumbing' });
    fake.db._set('job_offers/bk_g1', jobOffers.buildOfferDoc({ serviceType: 'plumbing' },
        { bookingId: 'bk_g1', artisanId: 'art_g1', expiresAtMs: Date.now() + 60000, round: 1 }));
    const r = await fns.bookingActions({ auth: { uid: 'art_g1' },
        data: { action: 'respondToJobOffer', payload: { bookingId: 'bk_g1', decision: 'accept' } } });
    assert.strictEqual(r.status, 'accepted');
    assert.deepStrictEqual([fake.db._get('bookings/bk_g1').status, fake.db._get('bookings/bk_g1').artisanId], ['accepted', 'art_g1']);
});

await t('another artisan is refused through the router exactly as directly', async () => {
    const req = { bookingId: 'bk_g1', decision: 'accept' };
    fake.db._set('bookings/bk_g1', { customerId: 'cust_g1', status: 'pending', currentArtisanId: 'art_g1', artisanId: null,
        dispatchStatus: 'dispatched', currentDispatchRound: 1 });
    const direct = await outcome(() => fns.respondToJobOffer({ auth: { uid: 'art_x' }, data: req }));
    const routed = await outcome(() => fns.bookingActions({ auth: { uid: 'art_x' }, data: { action: 'respondToJobOffer', payload: req } }));
    assert.strictEqual(direct.code, 'permission-denied');
    assert.deepStrictEqual(routed, direct);
});

await t('signed out: refused before the action is even looked up', async () => {
    for (const g of GROUPS) {
        const r = await outcome(() => fns[g]({ auth: null, data: { action: 'nope' } }));
        assert.deepStrictEqual([r.code, r.message], ['unauthenticated', 'Authentication required.']);
    }
});

await t('an unknown action is "unimplemented" with reason unknown_action — the client\'s cue to call directly', async () => {
    for (const action of ['nope', '', null, 42, '__proto__', 'constructor', 'toString', 'artisanAccount', 'walletActions']) {
        for (const g of GROUPS) {
            const r = await outcome(() => fns[g]({ auth: AUTH, data: { action, payload: {} } }));
            assert.deepStrictEqual([r.code, r.details], ['unimplemented', { reason: 'unknown_action' }], `${g}/${String(action)}`);
        }
    }
    const cross = await outcome(() => fns.walletActions({ auth: AUTH, data: { action: 'approveJobQuote', payload: {} } }));
    assert.strictEqual(cross.code, 'unimplemented', 'a booking action is not reachable through the wallet');
});

await t('a router whose action is not exported refuses to load (the deploy fails, not a customer)', () => {
    assert.throws(() => createGroupRouter('walletActions', { ...fns, verifyTopupNow: undefined }), /verifyTopupNow/);
    assert.throws(() => createGroupRouter('nope', fns), /Unknown callable group/);
});

console.log('\n── SDK · the routers resolve each member\'s real handler ──\n');

await t('with the real firebase-functions SDK, the routers dispatch through each member\'s .run', () => {
    // NO NETWORK. Without the fakes, firebase-admin would use this machine's
    // Google credentials and reach PRODUCTION Firestore (a rate-limit write did,
    // once, 2026-10-22). So the child gets a project that does not exist and an
    // emulator address nothing listens on, and the member is respondToJobOffer,
    // which refuses empty input before any read or write.
    const env = { ...process.env, GCLOUD_PROJECT: 'fx-no-network-test', FIRESTORE_EMULATOR_HOST: '127.0.0.1:9' };
    const script = `
        const f = require(${JSON.stringify(path.join(FN, 'index.js'))});
        (async () => {
            const out = {};
            for (const [name, req] of [
                ['signedOut', [f.walletActions, { auth: null, data: {} }]],
                ['unknown',   [f.bookingActions, { auth: { uid: 'u' }, data: { action: 'nope' } }]],
                ['member',    [f.bookingActions, { auth: { uid: 'u' }, data: { action: 'respondToJobOffer', payload: {} } }]],
                ['direct',    [f.respondToJobOffer, { auth: { uid: 'u' }, data: {} }]],
            ]) {
                try { await req[0].run(req[1]); out[name] = 'ok'; }
                catch (e) { out[name] = [e.code, e.message]; }
            }
            console.log(JSON.stringify(out));
            process.exit(0);
        })();`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: FN, env, encoding: 'utf8', timeout: 30000 })
        .trim().split('\n').pop());
    assert.deepStrictEqual(out.signedOut, ['unauthenticated', 'Authentication required.']);
    assert.strictEqual(out.unknown[0], 'unimplemented');
    assert.strictEqual(out.direct[0], 'invalid-argument', JSON.stringify(out.direct));
    assert.deepStrictEqual(out.member, out.direct, 'router and direct give the same answer under the real SDK');
});

console.log('\n── CLIENT · grouped calls go to the router; fallback only if it never ran ──\n');

// Load shared/js/services/callable.js with its three imports stubbed.
function loadClient() {
    const calls = [];
    const behaviour = {};      // functionName → (data) => result | throws
    const httpsCallable = (_fns, name) => async (data) => {
        calls.push([name, data]);
        const b = behaviour[name];
        if (!b) return { data: { from: name, data } };
        return b(data);
    };
    const strip = (src) => src
        .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*\n/gm, '')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
    const body = strip(read('shared/js/domain/callableGroups.js')) + '\n' + strip(read('shared/js/services/callable.js'));
    // eslint-disable-next-line no-new-func
    const mod = new Function('httpsCallable', 'firebaseFunctions', `${body}\nreturn { callable, routerNeverRan };`)(httpsCallable, {});
    return { ...mod, calls, behaviour };
}
const sdkError = (code, message = code, details) => Object.assign(new Error(message), { code: `functions/${code}`, details });

const quiet = console.warn; console.warn = () => {};

await t('a grouped action goes to its router as { action, payload }, and the answer comes back as before', async () => {
    const c = loadClient();
    const r = await c.callable('verifyTopupNow')({ reference: 'R1' });
    assert.deepStrictEqual(c.calls, [['walletActions', { action: 'verifyTopupNow', payload: { reference: 'R1' } }]]);
    assert.deepStrictEqual(r.data, { from: 'walletActions', data: { action: 'verifyTopupNow', payload: { reference: 'R1' } } });
    await c.callable('approveJobQuote')();
    assert.deepStrictEqual(c.calls[1], ['bookingActions', { action: 'approveJobQuote', payload: null }]);
});

await t('an action in no group is called by its own name, untouched', async () => {
    const c = loadClient();
    await c.callable('requestAccountDeletion')({});
    assert.deepStrictEqual(c.calls, [['requestAccountDeletion', {}]]);
});

await t('router not deployed (bare 404): the action is called directly, and from then on directly', async () => {
    const c = loadClient();
    c.behaviour.walletActions = () => { throw sdkError('not-found'); };
    const r = await c.callable('verifyTopupNow')({ reference: 'R1' });
    assert.strictEqual(r.data.from, 'verifyTopupNow');
    await c.callable('submitTopupOtp')({ reference: 'R1', otp: '123' });
    assert.deepStrictEqual(c.calls.map(([n]) => n), ['walletActions', 'verifyTopupNow', 'submitTopupOtp']);
});

await t('router not yet open to callers (bare platform 403): called directly', async () => {
    const c = loadClient();
    c.behaviour.bookingActions = () => { throw sdkError('permission-denied'); };
    const r = await c.callable('getPricingQuote')({ category: 'plumbing' });
    assert.strictEqual(r.data.from, 'getPricingQuote');
});

await t('router older than the client (unknown action): that call goes direct, the router is still used next time', async () => {
    const c = loadClient();
    c.behaviour.bookingActions = (d) => {
        if (d.action === 'rejectJobQuote') throw sdkError('unimplemented', 'Unknown bookingActions action.', { reason: 'unknown_action' });
        return { data: 'routed' };
    };
    assert.strictEqual((await c.callable('rejectJobQuote')({})).data.from, 'rejectJobQuote');
    assert.strictEqual((await c.callable('approveJobQuote')({})).data, 'routed');
});

await t('a handler\'s own error is the answer — never retried (that could pay twice)', async () => {
    const answers = [
        sdkError('not-found', 'Payment not found.'),
        sdkError('permission-denied', 'This offer was not made to you.', { reason: 'not_offered' }),
        sdkError('failed-precondition', 'Insufficient balance', { reason: 'insufficient_balance' }),
        sdkError('internal', 'internal'),
        sdkError('deadline-exceeded', 'deadline-exceeded'),
        sdkError('unavailable', 'unavailable'),
        sdkError('unimplemented', 'Not supported.'),
    ];
    for (const err of answers) {
        const c = loadClient();
        c.behaviour.walletActions = () => { throw err; };
        await assert.rejects(() => c.callable('processWithdrawal')({ amount: 10 }), (e) => e === err);
        assert.deepStrictEqual(c.calls.map(([n]) => n), ['walletActions'], `${err.code}: ${err.message} was retried`);
    }
});

await t('routerNeverRan: only the three "never reached a handler" signatures', () => {
    const { routerNeverRan } = loadClient();
    assert.ok(routerNeverRan(sdkError('not-found')));
    assert.ok(routerNeverRan(sdkError('permission-denied')));
    assert.ok(routerNeverRan(sdkError('unimplemented', 'x', { reason: 'unknown_action' })));
    assert.ok(!routerNeverRan(sdkError('not-found', 'Payment not found.')));
    assert.ok(!routerNeverRan(sdkError('not-found', 'not-found', {})));
    assert.ok(!routerNeverRan(sdkError('internal')));
    assert.ok(!routerNeverRan(null));
    assert.ok(!routerNeverRan(new Error('network')));
});

console.warn = quiet;

console.log('\n── SOURCE · no app calls a grouped action by name ──\n');

await t('every grouped call site in the apps goes through callable()', () => {
    const grouped = Object.values(CALLABLE_GROUPS).flat();
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['vendor', 'node_modules'].includes(e.name)) walk(rel); continue; }
            if (!/\.(js|html)$/.test(e.name)) continue;
            const src = read(rel);
            for (const a of grouped) {
                if (new RegExp(`httpsCallable\\([^)]*['"]${a}['"]`).test(src)) offenders.push(`${rel}: ${a}`);
            }
        }
    };
    for (const d of ['customer-app', 'artisan-app', 'admin-dashboard', 'shared']) walk(d);
    assert.deepStrictEqual(offenders, []);
});

await t('the generic call helpers route through callable()', () => {
    for (const rel of ['shared/js/services/pricingService.js', 'shared/js/services/walletService.js']) {
        assert.match(read(rel), /return callable\(name, fn\(\)\);/, rel);
    }
    assert.match(read('customer-app/js/pages/paymentPage.js'), /return callable\(name, firebaseFunctions\);/);
});

console.log(`\ncallable-groups: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const [n, e] of failures) console.error(`\n✗ ${n}\n${e.stack}`);
    process.exit(1);
}
process.exit(0);
})();
