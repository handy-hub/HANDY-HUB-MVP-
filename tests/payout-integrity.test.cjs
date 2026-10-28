'use strict';

/**
 * tests/payout-integrity.test.cjs — withdrawals and payouts: who can take money
 * out, where it can go, and that it moves exactly once whatever Paystack says.
 *
 * Run: node tests/payout-integrity.test.cjs
 *
 * WHAT THIS PROTECTS
 * ──────────────────
 * Withdrawals needed no PIN and paid any number the request named; an
 * ambiguous Paystack error refunded a transfer that may already have been
 * sent; duplicate webhooks could refund twice; nothing reconciled. These tests
 * drive the REAL code — the callables in functions/index.js, the webhook
 * handler with genuine HMAC signatures, transfers.js, the real Security PIN
 * module (scrypt + lockout) and the real Paystack client against a mocked
 * fetch — with a scripted fake standing in for Paystack's transfer API.
 *
 * Every scenario ends with a ledger check:
 *     balance + Σ(amount of payouts not refunded) == starting balance
 * so money can neither appear nor vanish in any terminal or open state.
 *
 * No network, no Paystack, no real money. Firestore is an in-memory fake whose
 * transactions serialise, matching the other functions harnesses.
 */

require('./support/no-production.cjs');   // must stay the first statement (npm run lint:tests)
const assert = require('assert');
const { fundCustomer, fundArtisan } = require('./support/walletEvidence.cjs');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

process.env.PIN_PEPPER          = 'test-pepper-0123456789abcdef0123456789abcdef';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_payout_integrity_only';

let passed = 0, failed = 0;
const failures = [];
const say = console.log.bind(console);
async function t(name, fn) {
    try { await fn(); passed++; say(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); say(`  FAIL  ${name}\n        ${e.message}`); }
}
async function rejects(fn, { code, re } = {}) {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    if (!err) throw new Error('expected a rejection, got none');
    if (code && err.code !== code) throw new Error(`expected code "${code}", got "${err.code}": ${err.message}`);
    if (re && !re.test(err.message)) throw new Error(`unexpected error: "${err.message}"`);
    return err;
}

// ── In-memory Firestore ───────────────────────────────────────────────────────
const INC = Symbol('inc'), DEL = Symbol('del');
function createFakeFirestore() {
    const store = new Map();
    const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
    const apply = (base, patch) => {
        const out = { ...(base || {}) };
        for (const [k, v] of Object.entries(patch)) {
            if (v && v[INC] !== undefined) out[k] = Math.round(((Number(out[k]) || 0) + v[INC]) * 100) / 100;
            else if (v && v[DEL]) delete out[k];
            else out[k] = clone(v);
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
            collection: (s) => collectionRef(`${p}/${s}`),
        };
    }
    const OPS = { '==': (a, b) => a === b, 'in': (a, b) => b.includes(a), '<=': (a, b) => a <= b, '<': (a, b) => a < b };
    function query(base, q = { f: [], lim: null }) {
        return {
            where: (f, op, v) => query(base, { ...q, f: [...q.f, [f, op, v]] }),
            orderBy: () => query(base, q),
            limit: (n) => query(base, { ...q, lim: n }),
            async get() {
                let docs = [...store.keys()]
                    .filter((k) => k.startsWith(`${base}/`) && !k.slice(base.length + 1).includes('/'))
                    .map(snap).filter((s) => q.f.every(([f, op, v]) => OPS[op](s.data()[f], v)));
                if (q.lim != null) docs = docs.slice(0, q.lim);
                return { empty: !docs.length, size: docs.length, docs };
            },
        };
    }
    function collectionRef(base) {
        return {
            ...query(base),
            doc: (id) => docRef(`${base}/${id || crypto.randomBytes(6).toString('hex')}`),
            async add(d) { const r = docRef(`${base}/${crypto.randomBytes(6).toString('hex')}`); await r.set(d); return r; },
        };
    }
    let chain = Promise.resolve();
    const hooks = { failTxns: 0 };
    function runTransaction(fn) {
        const run = chain.then(async () => {
            if (hooks.failTxns > 0) { hooks.failTxns--; throw new Error('simulated Firestore unavailable'); }
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
        collection: (n) => collectionRef(n), runTransaction, hooks,
        _set: (p, v) => store.set(p, clone(v)), _get: (p) => clone(store.get(p)), _has: (p) => store.has(p),
        _all: (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => ({ id: k.split('/').pop(), ...clone(store.get(k)) })),
        _reset() { store.clear(); chain = Promise.resolve(); hooks.failTxns = 0; },
    };
}

// ── Scripted Paystack transfer API ────────────────────────────────────────────
const FN_DIR = path.join(__dirname, '..', 'functions');
const realPaystack = require(path.join(FN_DIR, 'financial', 'paystack.js'));   // loaded before the intercept

const PS = {
    transfer: null, verify: null, calls: { transfer: [], verify: [], recipient: 0 },
    reset() {
        this.calls = { transfer: [], verify: [], recipient: 0 };
        this.transfer = async ({ reference }) => ({ status: 'pending', transfer_code: `TRF_${reference}`, reference });
        this.verify   = async () => null;
    },
};
const psErr = (outcome, message, httpStatus) => Object.assign(new Error(message), { outcome, httpStatus });
const fakePaystack = {
    ...realPaystack,
    createTransferRecipient: async ({ phone, provider }) => { PS.calls.recipient++; return { recipient_code: `RCP_${provider}_${phone}` }; },
    initiateTransfer: async (args) => { PS.calls.transfer.push(args); return PS.transfer(args); },
    verifyTransfer:   async (ref)  => { PS.calls.verify.push(ref); return PS.verify(ref); },
    verifyCharge:     async () => { throw new Error('not used here'); },
};

const FAKE_DB = createFakeFirestore();
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'firebase-admin/app') return { initializeApp: () => {} };
    if (request === 'firebase-admin/firestore') {
        return {
            getFirestore: () => FAKE_DB,
            FieldValue: { increment: (n) => ({ [INC]: n }), delete: () => ({ [DEL]: true }), serverTimestamp: () => new Date().toISOString() },
            FieldPath: { documentId: () => '__name__' },
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
    if (/(^|\/)paystack$/.test(request)) return fakePaystack;
    if (request === './dispatch') return { handleDispatchEvent: async () => {} };
    return origLoad.apply(this, arguments);
};

console.log = () => {}; console.warn = () => {}; console.error = () => {};
const index     = require(path.join(FN_DIR, 'index.js'));
const transfers = require(path.join(FN_DIR, 'financial', 'transfers.js'));
const webhooks  = require(path.join(FN_DIR, 'financial', 'webhooks.js'));
const pinMod    = require(path.join(FN_DIR, 'securityPin.js'));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ART = 'artisan_1', CUS = 'customer_1', PIN = '2468';
const ACCT = { provider: 'mtn', phone: '0241111111', accountName: 'Kofi Boateng' };
let rid = 0;
const newRid = () => `req-${Date.now()}-${++rid}-abcdef`;

async function seedArtisan({ available = 100, approved = true, status = 'active', account = ACCT, pin = true } = {}) {
    FAKE_DB._set(`artisans/${ART}`, {
        userType: 'artisan', name: 'Kofi', availableBalance: available, withdrawnTotal: 0,
        verificationStatus: approved ? 'approved' : 'pending_review', status,
    });
    fundArtisan(FAKE_DB, ART, available);
    if (account) FAKE_DB._set(`artisans/${ART}/private/kyc`, { artisanId: ART, payoutAccount: account });
    if (pin) await pinMod.setSecurityPin({ uid: ART }, { pin: PIN });
}
async function seedCustomer({ wallet = 100, toppedUpFrom = [{ provider: 'mtn', phone: '0552222222' }], pin = true } = {}) {
    FAKE_DB._set(`customers/${CUS}`, { userType: 'customer', name: 'Ama', walletBalance: wallet, escrowBalance: 0 });
    fundCustomer(FAKE_DB, CUS, wallet);
    toppedUpFrom.forEach((s, i) => FAKE_DB._set(`topupIntents/REF-${i}`, { uid: CUS, credited: true, ...s }));
    if (pin) await pinMod.setSecurityPin({ uid: CUS }, { pin: PIN });
}
const reset = () => { FAKE_DB._reset(); PS.reset(); };

const artCall = (data, uid = ART) => index.processArtisanWithdrawal({ auth: uid ? { uid, token: {} } : null, data });
const cusCall = (data, uid = CUS) => index.processWithdrawal({ auth: uid ? { uid, token: {} } : null, data });
const artWithdraw = (amount, extra = {}) => artCall({ amount, pin: PIN, requestId: newRid(), ...extra });

const payouts  = () => FAKE_DB._all('payouts/');
const payout   = () => { const p = payouts(); assert.strictEqual(p.length, 1, `expected 1 payout, got ${p.length}`); return p[0]; };
const balance  = (kind = 'artisan') => kind === 'artisan' ? FAKE_DB._get(`artisans/${ART}`).availableBalance : FAKE_DB._get(`customers/${CUS}`).walletBalance;
const alerts   = (kind) => FAKE_DB._all('admin_notifications/').filter((a) => !kind || a.kind === kind);
const refunds  = () => FAKE_DB._all('financialAudit/').filter((a) => a.action === 'withdrawal_refunded');

/** balance + Σ(non-refunded payouts) must equal the starting balance. */
function assertLedger(start, kind = 'artisan') {
    const held = payouts().filter((p) => p.userType === kind && !p.refundedAt).reduce((s, p) => s + p.amount, 0);
    const total = Math.round((balance(kind) + held) * 100) / 100;
    assert.strictEqual(total, start, `ledger broken: balance ${balance(kind)} + held ${held} != ${start}`);
}

function signedReq(event) {
    const raw = Buffer.from(JSON.stringify(event));
    const sig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
    return { headers: { 'x-paystack-signature': sig }, rawBody: raw, body: event };
}
function fakeRes() { return { statusCode: null, status(c) { this.statusCode = c; return this; }, json() { return this; } }; }
async function webhook(eventName, data) { const res = fakeRes(); await webhooks.handlePaystackWebhook(signedReq({ event: eventName, data }), res); return res.statusCode; }

const HOUR = 3600_000;
/** Age a payout so the reconciler will look at it. */
function age(ms) {
    for (const p of payouts()) {
        const old = new Date(Date.now() - ms).toISOString();
        FAKE_DB._set(`payouts/${p.id}`, { ...FAKE_DB._get(`payouts/${p.id}`), createdAt: old, updatedAt: old });
    }
}

(async () => {

say('\n── Who may withdraw ──\n');

await t('an unauthenticated call is refused', async () => {
    reset(); await seedArtisan();
    await rejects(() => artCall({ amount: 10, pin: PIN, requestId: newRid() }, null), { code: 'unauthenticated' });
    assert.strictEqual(payouts().length, 0);
});

await t('a request without a PIN is refused before anything moves', async () => {
    reset(); await seedArtisan();
    await rejects(() => artCall({ amount: 10, requestId: newRid() }), { code: 'invalid-argument' });
    assert.strictEqual(balance(), 100); assert.strictEqual(PS.calls.transfer.length, 0);
});

await t('a wrong PIN is refused: no payout, no Paystack call, balance untouched', async () => {
    reset(); await seedArtisan();
    await rejects(() => artWithdraw(10, { pin: '1357' }), { code: 'permission-denied' });
    assert.strictEqual(payouts().length, 0); assert.strictEqual(PS.calls.transfer.length, 0); assertLedger(100);
});

await t('an account with no PIN set cannot withdraw', async () => {
    reset(); await seedArtisan({ pin: false });
    await rejects(() => artWithdraw(10), { re: /PIN setup required/ });
    assert.strictEqual(balance(), 100);
});

await t('PIN guessing locks the account: after 5 wrong tries even the right PIN is refused', async () => {
    reset(); await seedArtisan();
    for (const p of ['1357', '9753', '8642', '3579', '7531']) await rejects(() => artWithdraw(10, { pin: p }));
    await rejects(() => artWithdraw(10), { code: 'resource-exhausted' });
    assert.strictEqual(payouts().length, 0); assertLedger(100);
});

await t('an artisan who is not approved, or is suspended, cannot withdraw', async () => {
    reset(); await seedArtisan({ approved: false });
    await rejects(() => artWithdraw(10), { re: /verified and active/ });
    reset(); await seedArtisan({ status: 'suspended' });
    await rejects(() => artWithdraw(10), { re: /verified and active/ });
    assertLedger(100);
});

await t('a customer cannot use the artisan withdrawal, nor an artisan the customer one', async () => {
    reset(); await seedCustomer();
    await rejects(() => artCall({ amount: 10, pin: PIN, requestId: newRid() }, CUS), { re: /not found/i });
    reset(); await seedArtisan();
    await rejects(() => cusCall({ amount: 10, provider: 'mtn', phone: '0241111111', pin: PIN, requestId: newRid() }, ART), { re: /not found/i });
});

say('\n── Where the money may go ──\n');

await t('an artisan cannot redirect the payout: provider/phone in the request are ignored', async () => {
    reset(); await seedArtisan();
    await artWithdraw(10, { provider: 'telecel', phone: '0209999999' });
    assert.strictEqual(PS.calls.transfer[0].recipientCode, 'RCP_mtn_0241111111');
    assert.strictEqual(payout().phone, '0241111111');
});

await t('an artisan with no payout account on file cannot withdraw', async () => {
    reset(); await seedArtisan({ account: null });
    await rejects(() => artWithdraw(10), { re: /No verified payout account/ });
    assertLedger(100);
});

await t('a customer can only withdraw to a number that funded a credited top-up', async () => {
    reset(); await seedCustomer();
    await rejects(() => cusCall({ amount: 10, provider: 'mtn', phone: '0249999999', pin: PIN, requestId: newRid() }),
        { re: /topped up from/ });
    assert.strictEqual(balance('customer'), 100);
    await cusCall({ amount: 10, provider: 'mtn', phone: '+233552222222', pin: PIN, requestId: newRid() });
    assert.strictEqual(payout().phone, '0552222222');
    assertLedger(100, 'customer');
});

await t('the same number on a different network is not a proven destination', async () => {
    reset(); await seedCustomer();
    await rejects(() => cusCall({ amount: 10, provider: 'telecel', phone: '0552222222', pin: PIN, requestId: newRid() }),
        { re: /topped up from/ });
});

await t('an UN-credited top-up does not prove a number', async () => {
    reset(); await seedCustomer({ toppedUpFrom: [] });
    FAKE_DB._set('topupIntents/REF-X', { uid: CUS, credited: false, provider: 'mtn', phone: '0552222222' });
    await rejects(() => cusCall({ amount: 10, provider: 'mtn', phone: '0552222222', pin: PIN, requestId: newRid() }),
        { re: /topped up from/ });
});

say('\n── Balance, concurrency and duplicates ──\n');

await t('more than the available balance is refused', async () => {
    reset(); await seedArtisan({ available: 50 });
    await rejects(() => artWithdraw(60), { re: /Insufficient balance/ });
    assert.strictEqual(payouts().length, 0); assertLedger(50);
});

await t('two concurrent withdrawals cannot overspend the balance', async () => {
    reset(); await seedArtisan({ available: 100 });
    const r = await Promise.allSettled([artWithdraw(70), artWithdraw(70)]);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.strictEqual(balance(), 30); assertLedger(100);
});

console.log('\n── Only VERIFIED money can be withdrawn (financial audit 2026-10-22) ──\n');

// A balance raised outside the server's money paths — the Firebase console,
// anything with project credentials — has no ledger evidence. It must never
// become a real Mobile Money payout. (functions/financial/walletIntegrity.js)

await t('an artisan balance raised in the console cannot be withdrawn; the real earnings can', async () => {
    reset(); await seedArtisan({ available: 100 });          // GHS 100 of real, released earnings
    FAKE_DB._set(`artisans/${ART}`, { ...FAKE_DB._get(`artisans/${ART}`), availableBalance: 1000 });   // the edit
    await assert.rejects(() => artWithdraw(500), /could not be matched to your payment history/);
    assert.strictEqual(payouts().length, 0, 'no payout was created');
    assert.strictEqual(PS.calls.transfer.length, 0, 'Paystack was never asked');
    assert.strictEqual(balance(), 1000, 'nothing moved');
    await artWithdraw(60);                                    // genuine money still leaves
    assert.strictEqual(payouts().length, 1);
    assert.ok(FAKE_DB._get(`walletIntegrityAlerts/artisan_${ART}`), 'an operator alert was recorded');
});

await t('a forged earning row (no escrow behind it) does not make money withdrawable', async () => {
    reset(); await seedArtisan({ available: 0 });
    FAKE_DB._set(`artisans/${ART}`, { ...FAKE_DB._get(`artisans/${ART}`), availableBalance: 500, totalEarned: 500 });
    FAKE_DB._set(`artisans/${ART}/transactions/forged`, { type: 'earning', amount: 500, status: 'completed', escrowId: 'no_such_escrow' });
    await assert.rejects(() => artWithdraw(100), /could not be matched/);
    assert.strictEqual(PS.calls.transfer.length, 0);
});

await t('one released escrow cannot back two earning rows', async () => {
    reset(); await seedArtisan({ available: 100 });
    const real = FAKE_DB._all(`artisans/${ART}/transactions/`)[0];
    FAKE_DB._set(`artisans/${ART}/transactions/copy`, { ...real });
    FAKE_DB._set(`artisans/${ART}`, { ...FAKE_DB._get(`artisans/${ART}`), availableBalance: 200 });
    await assert.rejects(() => artWithdraw(150), /could not be matched/);
    await artWithdraw(100);                                   // the real 100 is fine
});

await t('a customer wallet raised in the console (3 → 300) cannot be withdrawn to Mobile Money', async () => {
    reset(); await seedCustomer({ wallet: 3 });
    FAKE_DB._set(`customers/${CUS}`, { ...FAKE_DB._get(`customers/${CUS}`), walletBalance: 300 });
    await assert.rejects(() => cusCall({ amount: 200, pin: PIN, requestId: newRid(), provider: 'mtn', phone: '0552222222' }),
        /could not be matched/);
    assert.strictEqual(PS.calls.transfer.length, 0);
    assert.strictEqual(balance('customer'), 300, 'nothing moved');
});

await t('two concurrent withdrawals of verified money still cannot overspend', async () => {
    reset(); await seedArtisan({ available: 100 });
    const r = await Promise.allSettled([artWithdraw(70), artWithdraw(70), artWithdraw(70)]);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.strictEqual(balance(), 30); assertLedger(100);
});

await t('the same request sent twice makes ONE payout and ONE Paystack call', async () => {
    reset(); await seedArtisan();
    const requestId = newRid();
    const a = await artCall({ amount: 20, pin: PIN, requestId });
    const b = await artCall({ amount: 20, pin: PIN, requestId });
    assert.strictEqual(a.ref, b.ref); assert.strictEqual(b.duplicate, true);
    assert.strictEqual(payouts().length, 1); assert.strictEqual(PS.calls.transfer.length, 1);
    assert.strictEqual(balance(), 80); assertLedger(100);
});

await t('the same request sent concurrently still makes one payout', async () => {
    reset(); await seedArtisan();
    const requestId = newRid();
    await Promise.allSettled([1, 2, 3].map(() => artCall({ amount: 20, pin: PIN, requestId })));
    assert.strictEqual(payouts().length, 1); assert.strictEqual(balance(), 80); assertLedger(100);
});

await t('below-minimum amounts and malformed request ids are refused', async () => {
    reset(); await seedArtisan();
    await rejects(() => artWithdraw(1), { re: /Minimum withdrawal/ });
    await rejects(() => artCall({ amount: 10, pin: PIN, requestId: 'x' }), { re: /request id/ });
    assertLedger(100);
});

await t('every payout gets a unique server-generated Paystack reference', async () => {
    reset(); await seedArtisan();
    await artWithdraw(10); await artWithdraw(10); await artWithdraw(10);
    const refs = new Set(PS.calls.transfer.map((c) => c.reference));
    assert.strictEqual(refs.size, 3);
    for (const r of refs) assert.match(r, /^AW-\d+-[0-9A-F]{12}$/);
});

say('\n── Initiation outcomes ──\n');

await t('accepted by Paystack → processing, balance held', async () => {
    reset(); await seedArtisan();
    const r = await artWithdraw(25);
    assert.strictEqual(r.status, 'processing');
    assert.strictEqual(payout().status, 'processing'); assert.strictEqual(balance(), 75); assertLedger(100);
});

await t('definitively rejected → failed, refunded exactly once, user told', async () => {
    reset(); await seedArtisan();
    PS.transfer = async () => { throw psErr('rejected', 'Recipient account is invalid', 400); };
    await rejects(() => artWithdraw(25), { re: /could not be started/ });
    const p = payout();
    assert.strictEqual(p.status, 'failed'); assert.ok(p.refundedAt);
    assert.strictEqual(balance(), 100); assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('an initiation TIMEOUT is unknown: funds held, no refund, no error to the user', async () => {
    reset(); await seedArtisan();
    PS.transfer = async () => { throw psErr('unknown', 'Paystack POST /transfer timed out after 20000 ms'); };
    const r = await artWithdraw(25);
    assert.strictEqual(r.status, 'unknown');
    assert.strictEqual(payout().status, 'unknown'); assert.ok(!payout().refundedAt);
    assert.strictEqual(balance(), 75); assert.strictEqual(alerts('initiation_unknown').length, 1); assertLedger(100);
});

await t('a duplicate-reference refusal is unknown, never a refund', async () => {
    reset(); await seedArtisan();
    PS.transfer = async () => { throw psErr('unknown', 'Duplicate Transaction Reference', 400); };
    const r = await artWithdraw(25);
    assert.strictEqual(r.status, 'unknown'); assert.strictEqual(balance(), 75);
});

await t('Paystack accepted but OUR write failed → no refund; reconciler settles it later', async () => {
    reset(); await seedArtisan();
    PS.transfer = async ({ reference }) => { FAKE_DB.hooks.failTxns = 1; return { status: 'pending', transfer_code: 'TRF_X', reference }; };
    await artWithdraw(25);
    assert.strictEqual(payout().status, 'reserved', 'stays reserved — the accept was not recorded');
    assert.strictEqual(balance(), 75);
    PS.verify = async (ref) => ({ reference: ref, status: 'success', amount: 2500 });
    age(HOUR);
    await transfers.reconcilePayouts();
    assert.strictEqual(payout().status, 'success'); assert.strictEqual(balance(), 75); assertLedger(100);
});

await t('Paystack answering "success" at initiation settles it immediately', async () => {
    reset(); await seedArtisan();
    PS.transfer = async ({ reference }) => ({ status: 'success', transfer_code: 'TRF_S', reference });
    const r = await artWithdraw(25);
    assert.strictEqual(r.status, 'success'); assert.strictEqual(payout().status, 'success'); assertLedger(100);
});

await t('a transfer stuck at "otp" raises an operator alert (dashboard Transfer OTP)', async () => {
    reset(); await seedArtisan();
    PS.transfer = async ({ reference }) => ({ status: 'otp', transfer_code: 'TRF_O', reference });
    await artWithdraw(25);
    assert.strictEqual(payout().status, 'processing'); assert.strictEqual(alerts('transfer_otp').length, 1);
});

say('\n── Webhooks ──\n');

async function processingPayout(amount = 25) { reset(); await seedArtisan(); await artWithdraw(amount); return payout(); }

await t('transfer.success completes it; a duplicate delivery is a no-op', async () => {
    const p = await processingPayout();
    assert.strictEqual(await webhook('transfer.success', { reference: p.ref, amount: 2500 }), 200);
    assert.strictEqual(await webhook('transfer.success', { reference: p.ref, amount: 2500 }), 200);
    assert.strictEqual(payout().status, 'success'); assert.strictEqual(balance(), 75); assertLedger(100);
});

await t('transfer.failed refunds ONCE, however many times it is delivered', async () => {
    const p = await processingPayout();
    await webhook('transfer.failed', { reference: p.ref, amount: 2500 });
    await webhook('transfer.failed', { reference: p.ref, amount: 2500 });
    await Promise.all([1, 2, 3].map(() => webhook('transfer.failed', { reference: p.ref, amount: 2500 })));
    assert.strictEqual(payout().status, 'failed'); assert.strictEqual(balance(), 100);
    assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('out of order: failed AFTER success is refused and raised, never refunded', async () => {
    const p = await processingPayout();
    await webhook('transfer.success', { reference: p.ref, amount: 2500 });
    await webhook('transfer.failed',  { reference: p.ref, amount: 2500 });
    assert.strictEqual(payout().status, 'success'); assert.strictEqual(balance(), 75);
    assert.strictEqual(alerts('conflict').length, 1); assertLedger(100);
});

await t('reversed AFTER success refunds once (the bank returned the money)', async () => {
    const p = await processingPayout();
    await webhook('transfer.success',  { reference: p.ref, amount: 2500 });
    await webhook('transfer.reversed', { reference: p.ref, amount: 2500 });
    await webhook('transfer.reversed', { reference: p.ref, amount: 2500 });
    assert.strictEqual(payout().status, 'reversed'); assert.strictEqual(balance(), 100);
    assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('success AFTER a confirmed failure is raised for a human, not silently accepted', async () => {
    const p = await processingPayout();
    await webhook('transfer.failed',  { reference: p.ref, amount: 2500 });
    await webhook('transfer.success', { reference: p.ref, amount: 2500 });
    assert.strictEqual(payout().status, 'failed'); assert.strictEqual(alerts('conflict').length, 1);
});

await t('an event whose amount does not match the payout moves nothing', async () => {
    const p = await processingPayout();
    await webhook('transfer.failed', { reference: p.ref, amount: 999999 });
    assert.strictEqual(payout().status, 'processing'); assert.strictEqual(balance(), 75);
    assert.strictEqual(alerts('amount_mismatch').length, 1); assertLedger(100);
});

await t('an event for an unknown reference is acknowledged and ignored', async () => {
    const p = await processingPayout();
    assert.strictEqual(await webhook('transfer.failed', { reference: 'NOT-OURS', amount: 2500 }), 200);
    assert.strictEqual(payout().status, 'processing'); void p;
});

await t('an infrastructure error answers 500 so Paystack retries — and the retry settles once', async () => {
    const p = await processingPayout();
    FAKE_DB.hooks.failTxns = 1;
    assert.strictEqual(await webhook('transfer.failed', { reference: p.ref, amount: 2500 }), 500);
    assert.strictEqual(balance(), 75, 'nothing moved on the failed attempt');
    assert.strictEqual(await webhook('transfer.failed', { reference: p.ref, amount: 2500 }), 200);
    assert.strictEqual(balance(), 100); assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('a forged (unsigned) event is rejected', async () => {
    const p = await processingPayout();
    const res = fakeRes();
    await webhooks.handlePaystackWebhook({ headers: { 'x-paystack-signature': 'bad' }, rawBody: Buffer.from('{}'),
        body: { event: 'transfer.failed', data: { reference: p.ref } } }, res);
    assert.strictEqual(res.statusCode, 400); assert.strictEqual(balance(), 75);
});

say('\n── Reconciliation ──\n');

async function unknownPayout() {
    reset(); await seedArtisan();
    PS.transfer = async () => { throw psErr('unknown', 'socket hang up'); };
    await artWithdraw(25);
    assert.strictEqual(payout().status, 'unknown');
    return payout();
}

await t('unknown → Paystack says success → success, balance stays debited, re-run is a no-op', async () => {
    await unknownPayout();
    PS.verify = async (ref) => ({ reference: ref, status: 'success', amount: 2500 });
    age(HOUR);
    await transfers.reconcilePayouts(); await transfers.reconcilePayouts();
    assert.strictEqual(payout().status, 'success'); assert.strictEqual(balance(), 75); assertLedger(100);
});

await t('unknown → Paystack says failed → refunded once across repeated runs', async () => {
    await unknownPayout();
    PS.verify = async (ref) => ({ reference: ref, status: 'failed', amount: 2500 });
    age(HOUR);
    await transfers.reconcilePayouts(); await transfers.reconcilePayouts();
    assert.strictEqual(payout().status, 'failed'); assert.strictEqual(balance(), 100);
    assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('not found on Paystack is refunded only after the grace period AND two checks', async () => {
    await unknownPayout();
    PS.verify = async () => null;
    age(15 * 60_000);                                   // past MIN_AGE, inside NOT_FOUND_GRACE
    await transfers.reconcilePayouts();
    assert.strictEqual(balance(), 75, 'inside grace: no refund');
    age(HOUR);
    await transfers.reconcilePayouts();
    assert.strictEqual(balance(), 75, 'first not-found: no refund yet');
    age(HOUR);
    await transfers.reconcilePayouts();
    assert.strictEqual(payout().status, 'failed'); assert.strictEqual(balance(), 100);
    age(HOUR);
    await transfers.reconcilePayouts();
    assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('accepted (has a transfer code) but now "not found" is a contradiction: held + alert', async () => {
    reset(); await seedArtisan(); await artWithdraw(25);
    PS.verify = async () => null;
    age(2 * HOUR);
    await transfers.reconcilePayouts(); age(2 * HOUR); await transfers.reconcilePayouts();
    assert.strictEqual(payout().status, 'processing'); assert.strictEqual(balance(), 75);
    assert.strictEqual(alerts('accepted_but_not_found').length, 1);
});

await t('Paystack unreachable during reconciliation: nothing moves, alert after repeated errors', async () => {
    await unknownPayout();
    PS.verify = async () => { throw psErr('unknown', 'ECONNRESET'); };
    for (let i = 0; i < 3; i++) { age(HOUR); await transfers.reconcilePayouts(); }
    assert.strictEqual(payout().status, 'unknown'); assert.strictEqual(balance(), 75);
    assert.strictEqual(alerts('reconcile_errors').length, 1);
});

await t('reconciler and webhook racing on one failure refund exactly once', async () => {
    await unknownPayout();
    PS.verify = async (ref) => ({ reference: ref, status: 'failed', amount: 2500 });
    age(HOUR);
    const p = payout();
    await Promise.all([transfers.reconcilePayouts(), webhook('transfer.failed', { reference: p.ref, amount: 2500 })]);
    assert.strictEqual(balance(), 100); assert.strictEqual(refunds().length, 1); assertLedger(100);
});

await t('still pending after 24 hours raises ONE stale alert', async () => {
    reset(); await seedArtisan(); await artWithdraw(25);
    PS.verify = async (ref) => ({ reference: ref, status: 'pending', amount: 2500 });
    age(25 * HOUR); await transfers.reconcilePayouts();
    age(26 * HOUR); await transfers.reconcilePayouts();
    assert.strictEqual(alerts('stale_payout').length, 1); assert.strictEqual(balance(), 75);
});

await t('a payout settled minutes ago is left to the webhook', async () => {
    await unknownPayout();
    PS.verify = async (ref) => ({ reference: ref, status: 'failed', amount: 2500 });
    await transfers.reconcilePayouts();
    assert.strictEqual(PS.calls.verify.length, 0); assert.strictEqual(payout().status, 'unknown');
});

say('\n── The Paystack client tells "rejected" from "unknown" ──\n');

const realFetch = globalThis.fetch;
const mockFetch = (impl) => { globalThis.fetch = impl; };
const jsonRes = (status, body) => ({ status, json: async () => body });

await t('a clean 4xx refusal is "rejected"', async () => {
    mockFetch(async () => jsonRes(400, { status: false, message: 'Invalid recipient' }));
    const e = await rejects(() => realPaystack.initiateTransfer({ amountGHS: 5, recipientCode: 'R', reference: 'X' }));
    assert.strictEqual(e.outcome, 'rejected');
});

for (const [label, impl] of [
    ['a 5xx', async () => jsonRes(502, { status: false, message: 'Bad gateway' })],
    ['a network error', async () => { throw new TypeError('fetch failed'); }],
    ['a non-JSON body', async () => ({ status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
    ['a duplicate-reference refusal', async () => jsonRes(400, { status: false, message: 'Duplicate Transaction Reference' })],
    ['a 429', async () => jsonRes(429, { status: false, message: 'Too many requests' })],
]) {
    await t(`${label} is "unknown", never "rejected"`, async () => {
        mockFetch(impl);
        const e = await rejects(() => realPaystack.initiateTransfer({ amountGHS: 5, recipientCode: 'R', reference: 'X' }));
        assert.strictEqual(e.outcome, 'unknown');
    });
}

await t('a request that never answers times out as "unknown"', async () => {
    mockFetch((url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const t0 = Date.now();
    // initiateTransfer uses the module default (20 s); the shared helper is
    // exercised with a short timeout through verifyTransfer's error path below.
    const e = await rejects(() => realPaystack.verifyTransfer('X'));
    assert.strictEqual(e.outcome, 'unknown');
    assert.ok(Date.now() - t0 < 25_000);
});

await t('verifyTransfer: 404 means "no such transfer", 5xx throws unknown', async () => {
    mockFetch(async () => jsonRes(404, { status: false, message: 'Transfer not found' }));
    assert.strictEqual(await realPaystack.verifyTransfer('X'), null);
    mockFetch(async () => jsonRes(500, { status: false, message: 'Server error' }));
    const e = await rejects(() => realPaystack.verifyTransfer('X'));
    assert.strictEqual(e.outcome, 'unknown');
});
globalThis.fetch = realFetch;

say('\n── Artisans can hold a Security PIN without becoming customers ──\n');

await t('setSecurityPin works for an artisan and never creates a customer record', async () => {
    reset();
    FAKE_DB._set(`artisans/${ART}`, { userType: 'artisan', name: 'Kofi' });
    await pinMod.setSecurityPin({ uid: ART }, { pin: PIN });
    assert.strictEqual(FAKE_DB._get(`artisans/${ART}/private/security`).securityPinConfigured, true);
    assert.ok(!FAKE_DB._has(`customers/${ART}`), 'role isolation: no customers/{artisan}');
    assert.ok(!('securityPinConfigured' in FAKE_DB._get(`artisans/${ART}`)), 'not on the public profile');
});

await t('an account that is neither customer nor artisan cannot set a PIN', async () => {
    reset();
    await rejects(() => pinMod.setSecurityPin({ uid: 'nobody' }, { pin: PIN }), { re: /profile not found/ });
});

say('\n── No client chooses the artisan payout destination ──\n');

await t('the artisan withdrawal wrapper and wallet page send no provider or phone', async () => {
    const svc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'js', 'services', 'walletService.js'), 'utf8');
    const m = svc.match(/export async function withdrawArtisan\(([^)]*)\)[\s\S]*?\n\}/);
    assert.ok(m, 'withdrawArtisan not found');
    assert.ok(!/phone|provider/.test(m[0]), 'withdrawArtisan must not send a destination');
    const page = fs.readFileSync(path.join(__dirname, '..', 'artisan-app', 'wallet.html'), 'utf8');
    assert.ok(!/withdrawArtisan\(\{[^}]*phone/.test(page), 'wallet.html must not send a phone');
});

say(`\npayout-integrity: ${passed} passed, ${failed} failed`);
if (failed) { for (const [n, e] of failures) say(`\n✗ ${n}\n${e.stack}`); process.exit(1); }
process.exit(0);
})();
