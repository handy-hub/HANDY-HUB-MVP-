'use strict';

/**
 * tests/topup-charge.test.cjs — wallet top-up money invariants.
 *
 * Run: node tests/topup-charge.test.cjs
 *
 * These are not UI assertions. Each test targets a way real money could be
 * lost, duplicated, or credited to the wrong wallet:
 *
 *   • amount validation      — no NaN/Infinity/negative/sub-pesewa/over-cap charges
 *   • reference generation   — unguessable, so no one can target another's intent
 *   • webhook signature      — forged webhooks cannot credit anything
 *   • credit idempotency     — duplicate and CONCURRENT deliveries credit once
 *   • intent authority       — the wallet follows our record, not Paystack metadata
 *   • amount/currency match  — a charge that disagrees with the intent is refused
 *   • state machine          — a settled intent is never downgraded
 *
 * Firestore is replaced with an in-memory fake whose runTransaction SERIALISES,
 * which is the guarantee real Firestore transactions provide. That is what makes
 * the concurrency test meaningful rather than decorative.
 */

const assert = require('assert');
const path   = require('path');
const crypto = require('crypto');
const Module = require('module');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(
                () => { passed++; console.log(`  PASS  ${name}`); },
                (e) => { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); },
            );
        }
        passed++; console.log(`  PASS  ${name}`);
    } catch (e) {
        failed++; failures.push([name, e]);
        console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
}

async function throwsAsync(fn, matcher, msg) {
    try { await fn(); }
    catch (e) {
        if (matcher && !matcher(e)) throw new Error(`${msg || 'wrong error'}: got ${e.code || ''} ${e.message}`);
        return e;
    }
    throw new Error(msg || 'expected a throw, got none');
}

// ── In-memory Firestore fake ──────────────────────────────────────────────────
function createFakeFirestore() {
    const store = new Map();                     // path -> plain object
    const clone = (o) => JSON.parse(JSON.stringify(o));

    function docRef(p) {
        return {
            path: p,
            id: p.split('/').pop(),
            async get() {
                const d = store.get(p);
                return { exists: d !== undefined, id: p.split('/').pop(), data: () => (d ? clone(d) : undefined) };
            },
            async set(data, opts) {
                if (opts && opts.merge && store.has(p)) store.set(p, { ...store.get(p), ...clone(data) });
                else store.set(p, clone(data));
            },
            async update(data) {
                if (!store.has(p)) throw new Error('update on missing doc');
                store.set(p, { ...store.get(p), ...clone(data) });
            },
            async delete() { store.delete(p); },
            collection(sub) { return collectionRef(`${p}/${sub}`); },
        };
    }

    function collectionRef(base) {
        return {
            doc(id) { return docRef(id ? `${base}/${id}` : `${base}/auto_${crypto.randomBytes(6).toString('hex')}`); },
            async add(data) {
                const p = `${base}/auto_${crypto.randomBytes(6).toString('hex')}`;
                store.set(p, clone(data));
                return docRef(p);
            },
        };
    }

    // Serialised transactions — models Firestore's atomicity guarantee.
    let chain = Promise.resolve();
    function runTransaction(fn) {
        const run = chain.then(async () => {
            const writes = [];
            const txn = {
                async get(ref) { return ref.get(); },
                set(ref, data, opts) { writes.push(() => ref.set(data, opts)); },
                update(ref, data)    { writes.push(() => ref.update(data)); },
                delete(ref)          { writes.push(() => ref.delete()); },
            };
            const result = await fn(txn);
            for (const w of writes) await w();
            return result;
        });
        chain = run.catch(() => {});
        return run;
    }

    return {
        collection: (n) => collectionRef(n),
        runTransaction,
        _store: store,
        _dump: () => Object.fromEntries(store),
        // Reset IN PLACE. The modules under test hold a lazy Firestore
        // singleton, so they pin whichever object they first received —
        // reassigning the variable would leave them writing to a detached store
        // while assertions read an empty one.
        _reset() { store.clear(); chain = Promise.resolve(); },
    };
}

// ── Module interception ───────────────────────────────────────────────────────
const FN_DIR = path.join(__dirname, '..', 'functions');
const FAKE_DB = createFakeFirestore();
const paystackMock = { verifyCharge: null, initializeTransaction: null };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'firebase-admin/firestore') {
        return { getFirestore: () => FAKE_DB, FieldValue: { increment: (n) => ({ __inc: n }) } };
    }
    if (request === 'firebase-functions/v2/https') {
        class HttpsError extends Error {
            constructor(code, message) { super(message); this.code = code; }
        }
        return { HttpsError, onCall: () => {} };
    }
    return origLoad.apply(this, arguments);
};

// Load modules under test AFTER interception is installed.
const topups   = require(path.join(FN_DIR, 'topups.js'));
const wallets  = require(path.join(FN_DIR, 'financial', 'wallets.js'));

// Patch the paystack module in cache so webhooks.js picks up our stubs.
const paystackPath = require.resolve(path.join(FN_DIR, 'financial', 'paystack.js'));
const realPaystack = require(paystackPath);
require.cache[paystackPath].exports = {
    ...realPaystack,
    verifyCharge:          (...a) => paystackMock.verifyCharge(...a),
    initializeTransaction: (...a) => paystackMock.initializeTransaction(...a),
};

const webhooks = require(path.join(FN_DIR, 'financial', 'webhooks.js'));

// ── Helpers ───────────────────────────────────────────────────────────────────
const SECRET = 'sk_test_dummy_secret_for_signature_tests';
process.env.PAYSTACK_SECRET_KEY = SECRET;

function signedRequest(bodyObj, secret = SECRET) {
    const raw = JSON.stringify(bodyObj);
    const sig = crypto.createHmac('sha512', secret).update(raw).digest('hex');
    return {
        headers: { 'x-paystack-signature': sig },
        rawBody: Buffer.from(raw, 'utf8'),
        body: bodyObj,
    };
}

function fakeRes() {
    const r = { statusCode: null, payload: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json   = (p) => { r.payload = p; return r; };
    return r;
}

/** Wait for the webhook's post-200 async processing to drain. */
const drain = () => new Promise((res) => setTimeout(res, 30));

async function seedCustomer(uid, walletBalance = 0) {
    await FAKE_DB.collection('customers').doc(uid).set({ walletBalance, userType: 'customer' });
}
async function seedIntent(reference, fields) {
    await FAKE_DB.collection('topupIntents').doc(reference).set({
        status: 'pending', credited: false, currency: 'GHS', ...fields,
    });
}
const getDoc = async (col, id) => (await FAKE_DB.collection(col).doc(id).get()).data();

// ═════════════════════════════════════════════════════════════════════════════
(async function run() {
console.log('\nTOP-UP CHARGE — money invariants\n');

// ── 1. Amount validation ─────────────────────────────────────────────────────
console.log('Amount validation (server-side)');
const bad = [
    ['negative',        -5],
    ['zero',             0],
    ['NaN',            NaN],
    ['Infinity',  Infinity],
    ['-Infinity',-Infinity],
    ['string',       '100'],
    ['null',          null],
    ['undefined',undefined],
    ['object',        {a:1}],
    ['boolean',       true],
    ['sub-pesewa',  10.005],
    ['below minimum', 0.5],
    ['above maximum', 999999],
];
for (const [label, value] of bad) {
    test(`rejects ${label}`, () => {
        assert.throws(() => topups.toPesewasOrThrow(value), (e) => e.code === 'invalid-argument');
    });
}
test('accepts 1.00 → 100 pesewas',      () => assert.strictEqual(topups.toPesewasOrThrow(1),      100));
test('accepts 10.50 → 1050 pesewas',    () => assert.strictEqual(topups.toPesewasOrThrow(10.5),   1050));
test('accepts 0.1+0.2 float artefact',  () => assert.strictEqual(topups.toPesewasOrThrow(0.1+0.2+9.7), 1000));
test('integer pesewas, never float',    () => assert.ok(Number.isSafeInteger(topups.toPesewasOrThrow(3.33))));

// ── 2. Reference generation ──────────────────────────────────────────────────
console.log('\nReference generation');
test('references are unique across 5000 draws', () => {
    const s = new Set();
    for (let i = 0; i < 5000; i++) s.add(topups.generateReference());
    assert.strictEqual(s.size, 5000);
});
test('reference charset is Paystack-safe', () => {
    for (let i = 0; i < 200; i++) assert.ok(/^[A-Za-z0-9\-._=]+$/.test(topups.generateReference()));
});
test('reference carries >=96 bits of entropy', () => {
    // 12 random bytes rendered as 24 hex chars.
    assert.ok(/-[0-9A-F]{24}$/.test(topups.generateReference()));
});

// ── 2b. MoMo destination validation ──────────────────────────────────────────
// A wrong number sends the approval prompt to a stranger's handset, so these
// must never guess. Direct-charge replaced the Paystack popup, which means the
// phone/provider are now load-bearing rather than decorative.
console.log('\nMobile money destination validation');
test('accepts local 0XXXXXXXXX form', () => {
    assert.strictEqual(topups.normalizeGhanaPhoneOrThrow('0551234567'), '0551234567');
});
test('normalizes 233 and +233 to local form', () => {
    assert.strictEqual(topups.normalizeGhanaPhoneOrThrow('233551234567'),  '0551234567');
    assert.strictEqual(topups.normalizeGhanaPhoneOrThrow('+233551234567'), '0551234567');
});
test('tolerates spaces, dashes and parentheses', () => {
    assert.strictEqual(topups.normalizeGhanaPhoneOrThrow(' 055 123-4567 '),  '0551234567');
    assert.strictEqual(topups.normalizeGhanaPhoneOrThrow('+233 (55) 123 4567'), '0551234567');
});
test('rejects malformed numbers rather than guessing', () => {
    for (const bad of ['', null, undefined, '123', '05512345678', '0551234a67',
                       '15551234567', '+4479123456789', '0000000000000',
                       {}, [], '  ', '233', '+233']) {
        assert.throws(
            () => topups.normalizeGhanaPhoneOrThrow(bad),
            (e) => e.code === 'invalid-argument',
            `should reject ${JSON.stringify(bad)}`,
        );
    }
});
test('accepts the three supported networks', () => {
    for (const p of ['mtn', 'telecel', 'airteltigo']) {
        assert.strictEqual(topups.normalizeProviderOrThrow(p), p);
    }
});
test('maps legacy Vodafone naming to telecel', () => {
    assert.strictEqual(topups.normalizeProviderOrThrow('vodafone'), 'telecel');
    assert.strictEqual(topups.normalizeProviderOrThrow('vod'),      'telecel');
    assert.strictEqual(topups.normalizeProviderOrThrow('MTN'),      'mtn');
});
test('rejects unsupported providers', () => {
    for (const bad of ['', null, 'paypal', 'visa', 'glo', 'mpesa', 42, {}]) {
        assert.throws(
            () => topups.normalizeProviderOrThrow(bad),
            (e) => e.code === 'invalid-argument',
            `should reject ${JSON.stringify(bad)}`,
        );
    }
});

// ── 3. Webhook signature ─────────────────────────────────────────────────────
console.log('\nWebhook signature verification');
await test('rejects a missing signature', async () => {
    const res = fakeRes();
    await webhooks.handlePaystackWebhook({ headers: {}, rawBody: Buffer.from('{}'), body: {} }, res);
    assert.strictEqual(res.statusCode, 400);
});
await test('rejects a forged signature', async () => {
    const req = signedRequest({ event: 'charge.success', data: { reference: 'X' } }, 'wrong_secret');
    const res = fakeRes();
    await webhooks.handlePaystackWebhook(req, res);
    assert.strictEqual(res.statusCode, 400);
});
await test('rejects a truncated signature (length guard)', async () => {
    const req = signedRequest({ event: 'charge.success', data: { reference: 'X' } });
    req.headers['x-paystack-signature'] = req.headers['x-paystack-signature'].slice(0, 40);
    const res = fakeRes();
    await webhooks.handlePaystackWebhook(req, res);
    assert.strictEqual(res.statusCode, 400);
});
await test('accepts a correctly signed payload', async () => {
    FAKE_DB._reset();
    const req = signedRequest({ event: 'some.unhandled', data: {} });
    const res = fakeRes();
    await webhooks.handlePaystackWebhook(req, res);
    assert.strictEqual(res.statusCode, 200);
});

// ── 4. Credit idempotency ────────────────────────────────────────────────────
console.log('\nWallet credit idempotency');
await test('duplicate sequential credits apply exactly once', async () => {
    FAKE_DB._reset();
    await seedCustomer('u1', 100);
    const args = { uid: 'u1', amountGHS: 50, paystackRef: 'REF-DUP-1' };
    const a = await wallets.creditWalletFromCharge(args);
    const b = await wallets.creditWalletFromCharge(args);
    assert.strictEqual(a.credited, true,  'first credit should apply');
    assert.strictEqual(b.credited, false, 'second must not apply');
    assert.strictEqual(b.duplicate, true);
    assert.strictEqual((await getDoc('customers', 'u1')).walletBalance, 150);
});
await test('CONCURRENT duplicate deliveries credit exactly once', async () => {
    FAKE_DB._reset();
    await seedCustomer('u2', 0);
    const args = { uid: 'u2', amountGHS: 25, paystackRef: 'REF-RACE-1' };
    const results = await Promise.all([
        wallets.creditWalletFromCharge(args),
        wallets.creditWalletFromCharge(args),
        wallets.creditWalletFromCharge(args),
    ]);
    assert.strictEqual(results.filter(r => r.credited).length, 1, 'exactly one credit must win');
    assert.strictEqual((await getDoc('customers', 'u2')).walletBalance, 25);
});
await test('idempotency survives even with no prior balance field', async () => {
    FAKE_DB._reset();
    await FAKE_DB.collection('customers').doc('u3').set({ userType: 'customer' });
    await wallets.creditWalletFromCharge({ uid: 'u3', amountGHS: 10, paystackRef: 'REF-NB' });
    await wallets.creditWalletFromCharge({ uid: 'u3', amountGHS: 10, paystackRef: 'REF-NB' });
    assert.strictEqual((await getDoc('customers', 'u3')).walletBalance, 10);
});
await test('credit and intent settle atomically (no pending-after-credit)', async () => {
    FAKE_DB._reset();
    await seedCustomer('u4', 0);
    await seedIntent('REF-ATOMIC', { uid: 'u4', amountPesewas: 4000 });
    await wallets.creditWalletFromCharge({ uid: 'u4', amountGHS: 40, paystackRef: 'REF-ATOMIC', hasIntent: true });
    const intent = await getDoc('topupIntents', 'REF-ATOMIC');
    assert.strictEqual((await getDoc('customers', 'u4')).walletBalance, 40);
    assert.strictEqual(intent.status, 'successful');
    assert.strictEqual(intent.credited, true);
});

// ── 5. Webhook end-to-end authority ──────────────────────────────────────────
console.log('\nWebhook → wallet authority');

await test('credits the intent owner, IGNORING attacker metadata.userId', async () => {
    FAKE_DB._reset();
    await seedCustomer('victim', 0);
    await seedCustomer('attacker', 0);
    await seedIntent('REF-IDOR', { uid: 'victim', amountPesewas: 10000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 10000, currency: 'GHS' });

    // Attacker-controlled metadata claims a different owner.
    const req = signedRequest({
        event: 'charge.success',
        data: { reference: 'REF-IDOR', metadata: { userId: 'attacker', userType: 'customer' } },
    });
    await webhooks.handlePaystackWebhook(req, fakeRes());
    await drain();

    assert.strictEqual((await getDoc('customers', 'victim')).walletBalance, 100, 'intent owner must be credited');
    assert.strictEqual((await getDoc('customers', 'attacker')).walletBalance, 0, 'metadata must NOT redirect funds');
});

await test('refuses credit when charged amount != intent amount', async () => {
    FAKE_DB._reset();
    await seedCustomer('u5', 0);
    await seedIntent('REF-AMT', { uid: 'u5', amountPesewas: 5000 });      // we asked for GHS 50
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 100, currency: 'GHS' }); // paid GHS 1

    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-AMT', metadata: {} } }), fakeRes());
    await drain();

    assert.strictEqual((await getDoc('customers', 'u5')).walletBalance, 0, 'must not credit on mismatch');
    assert.strictEqual((await getDoc('topupIntents', 'REF-AMT')).status, 'failed');
});

await test('refuses credit on currency mismatch', async () => {
    FAKE_DB._reset();
    await seedCustomer('u6', 0);
    await seedIntent('REF-CUR', { uid: 'u6', amountPesewas: 5000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 5000, currency: 'NGN' });

    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-CUR', metadata: {} } }), fakeRes());
    await drain();

    assert.strictEqual((await getDoc('customers', 'u6')).walletBalance, 0);
    assert.strictEqual((await getDoc('topupIntents', 'REF-CUR')).status, 'failed');
});

await test('refuses credit when Paystack says the charge did not succeed', async () => {
    FAKE_DB._reset();
    await seedCustomer('u7', 0);
    await seedIntent('REF-UNSUCC', { uid: 'u7', amountPesewas: 5000 });
    paystackMock.verifyCharge = async () => ({ status: 'abandoned', amount: 5000, currency: 'GHS' });

    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-UNSUCC', metadata: {} } }), fakeRes());
    await drain();

    assert.strictEqual((await getDoc('customers', 'u7')).walletBalance, 0);
});

await test('repeated successful webhook deliveries credit exactly once', async () => {
    FAKE_DB._reset();
    await seedCustomer('u8', 0);
    await seedIntent('REF-REPLAY', { uid: 'u8', amountPesewas: 2500 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 2500, currency: 'GHS' });
    const req = () => signedRequest({ event: 'charge.success', data: { reference: 'REF-REPLAY', metadata: {} } });

    await webhooks.handlePaystackWebhook(req(), fakeRes()); await drain();
    await webhooks.handlePaystackWebhook(req(), fakeRes()); await drain();
    await webhooks.handlePaystackWebhook(req(), fakeRes()); await drain();

    assert.strictEqual((await getDoc('customers', 'u8')).walletBalance, 25, 'must credit once, not three times');
});

await test('unknown reference does not create or credit a wallet', async () => {
    FAKE_DB._reset();
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 1000, currency: 'GHS' });
    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-NOPE', metadata: {} } }), fakeRes());
    await drain();
    assert.strictEqual(Object.keys(FAKE_DB._dump()).filter(k => k.startsWith('customers/')).length, 0);
});

// ── 6. State machine ─────────────────────────────────────────────────────────
console.log('\nPayment state machine');
await test('a settled (credited) intent is never downgraded by a late failure', async () => {
    FAKE_DB._reset();
    await seedCustomer('u9', 0);
    await seedIntent('REF-LATE', { uid: 'u9', amountPesewas: 3000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 3000, currency: 'GHS' });

    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-LATE', metadata: {} } }), fakeRes());
    await drain();
    // A late, out-of-order charge.failed for the same reference.
    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.failed', data: { reference: 'REF-LATE' } }), fakeRes());
    await drain();

    const intent = await getDoc('topupIntents', 'REF-LATE');
    assert.strictEqual(intent.status, 'successful', 'credited intent must stay successful');
    assert.strictEqual((await getDoc('customers', 'u9')).walletBalance, 30);
});
await test('charge.failed settles a pending intent', async () => {
    FAKE_DB._reset();
    await seedIntent('REF-FAIL', { uid: 'u10', amountPesewas: 3000 });
    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.failed', data: { reference: 'REF-FAIL' } }), fakeRes());
    await drain();
    assert.strictEqual((await getDoc('topupIntents', 'REF-FAIL')).status, 'failed');
});

// ── 7. Dual confirmation paths converge safely ───────────────────────────────
// The webhook and the client-triggered verifyTopupNow both settle a charge. They
// can arrive in any order, concurrently, or repeatedly. Money must move once.
console.log('\nDual-path confirmation (webhook + verifyTopupNow)');

await test('verifyTopupNow credits when Paystack says success', async () => {
    await seedCustomer('v1', 10);
    await seedIntent('REF-VERIFY-01', { uid: 'v1', amountPesewas: 2500 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 2500, currency: 'GHS' });

    const r = await topups.verifyTopupNow({ uid: 'v1' }, { reference: 'REF-VERIFY-01' });
    assert.strictEqual(r.credited, true);
    assert.strictEqual((await getDoc('customers', 'v1')).walletBalance, 35);
});

await test('verify then webhook credits exactly once', async () => {
    await seedCustomer('v2', 0);
    await seedIntent('REF-VERIFY-02', { uid: 'v2', amountPesewas: 5000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 5000, currency: 'GHS' });

    await topups.verifyTopupNow({ uid: 'v2' }, { reference: 'REF-VERIFY-02' });
    const res = fakeRes();
    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-VERIFY-02' } }), res);
    await drain();

    assert.strictEqual((await getDoc('customers', 'v2')).walletBalance, 50);
});

await test('webhook then verify credits exactly once', async () => {
    await seedCustomer('v3', 0);
    await seedIntent('REF-VERIFY-03', { uid: 'v3', amountPesewas: 3000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 3000, currency: 'GHS' });

    const res = fakeRes();
    await webhooks.handlePaystackWebhook(
        signedRequest({ event: 'charge.success', data: { reference: 'REF-VERIFY-03' } }), res);
    await drain();
    const r = await topups.verifyTopupNow({ uid: 'v3' }, { reference: 'REF-VERIFY-03' });

    assert.strictEqual(r.credited, true);
    assert.strictEqual((await getDoc('customers', 'v3')).walletBalance, 30);
});

await test('concurrent verify + webhook credit exactly once', async () => {
    await seedCustomer('v4', 0);
    await seedIntent('REF-VERIFY-04', { uid: 'v4', amountPesewas: 8000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 8000, currency: 'GHS' });

    const res = fakeRes();
    await Promise.all([
        topups.verifyTopupNow({ uid: 'v4' }, { reference: 'REF-VERIFY-04' }),
        webhooks.handlePaystackWebhook(
            signedRequest({ event: 'charge.success', data: { reference: 'REF-VERIFY-04' } }), res),
    ]);
    await drain();

    assert.strictEqual((await getDoc('customers', 'v4')).walletBalance, 80);
});

await test('repeated verifyTopupNow never double-credits', async () => {
    await seedCustomer('v5', 0);
    await seedIntent('REF-VERIFY-05', { uid: 'v5', amountPesewas: 1500 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 1500, currency: 'GHS' });

    for (let i = 0; i < 6; i++) await topups.verifyTopupNow({ uid: 'v5' }, { reference: 'REF-VERIFY-05' });
    assert.strictEqual((await getDoc('customers', 'v5')).walletBalance, 15);
});

await test('an in-progress charge stays pending, never marked failed', async () => {
    // The old code treated any non-success as failure. Mid-approval that would
    // have told a paying customer their payment had failed.
    await seedCustomer('v6', 0);
    await seedIntent('REF-VERIFY-06', { uid: 'v6', amountPesewas: 2000 });
    paystackMock.verifyCharge = async () => ({ status: 'ongoing', amount: 2000, currency: 'GHS' });

    const r = await topups.verifyTopupNow({ uid: 'v6' }, { reference: 'REF-VERIFY-06' });
    assert.strictEqual(r.status, 'pending');
    assert.strictEqual(r.credited, false);
    assert.strictEqual((await getDoc('topupIntents', 'REF-VERIFY-06')).status, 'pending');
    assert.strictEqual((await getDoc('customers', 'v6')).walletBalance, 0);
});

await test('a customer cannot verify a reference they do not own (IDOR)', async () => {
    await seedCustomer('owner', 0);
    await seedCustomer('attacker', 0);
    await seedIntent('REF-VERIFY-07', { uid: 'owner', amountPesewas: 9000 });
    paystackMock.verifyCharge = async () => ({ status: 'success', amount: 9000, currency: 'GHS' });

    await assert.rejects(
        () => topups.verifyTopupNow({ uid: 'attacker' }, { reference: 'REF-VERIFY-07' }),
        (e) => e.code === 'not-found',
    );
    assert.strictEqual((await getDoc('customers', 'attacker')).walletBalance, 0);
    assert.strictEqual((await getDoc('customers', 'owner')).walletBalance, 0);
});

await test('a transient Paystack outage reports pending, not failure', async () => {
    await seedCustomer('v8', 0);
    await seedIntent('REF-VERIFY-08', { uid: 'v8', amountPesewas: 4000 });
    paystackMock.verifyCharge = async () => { throw new Error('ETIMEDOUT'); };

    const r = await topups.verifyTopupNow({ uid: 'v8' }, { reference: 'REF-VERIFY-08' });
    assert.strictEqual(r.status, 'pending');
    assert.strictEqual(r.credited, false);
    assert.strictEqual((await getDoc('topupIntents', 'REF-VERIFY-08')).status, 'pending');
});

await test('verify rejects a malformed reference', async () => {
    for (const bad of ['', 'x', null, undefined, 'a'.repeat(200), '../../etc', {}]) {
        await assert.rejects(
            () => topups.verifyTopupNow({ uid: 'v1' }, { reference: bad }),
            (e) => e.code === 'invalid-argument' || e.code === 'not-found',
        );
    }
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(52)}\n`);
Module._load = origLoad;
process.exit(failed === 0 ? 0 : 1);
})();
