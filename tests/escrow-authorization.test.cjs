'use strict';

/**
 * tests/escrow-authorization.test.cjs — who may move escrowed money, and when.
 *
 * Run: node tests/escrow-authorization.test.cjs
 *
 * WHAT THIS PROTECTS
 * ──────────────────
 * The escrow callables authorised "either party to the escrow" and never looked
 * at the booking. An artisan could release a customer's payment to themselves
 * before doing the work; a customer could refund themselves after the work was
 * done, or in the middle of a dispute; and holdBookingFunds let a customer
 * pre-lock their own booking with GHS 0.01 so the real payment was silently
 * treated as already taken.
 *
 * Money now leaves escrow only because the BOOKING reached a state that decides
 * it — completion, cancellation, expiry, or an administrator's dispute
 * resolution — and those paths must keep working. This file proves both halves
 * against the real code: the callable handlers in functions/index.js, the
 * onBookingStatusChanged trigger, the auto-release scheduler and resolveDispute.
 *
 * Firestore is an in-memory fake whose runTransaction serialises, matching the
 * harness in topup-charge.test.cjs and emergency-pricing.test.cjs, extended
 * with the query support those server paths use.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const Module = require('module');

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

async function rejects(fn, { code, re } = {}, msg = 'expected a rejection, got none') {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    if (!err) throw new Error(msg);
    if (code && err.code !== code) throw new Error(`expected code "${code}", got "${err.code}": ${err.message}`);
    if (re && !re.test(err.message)) throw new Error(`unexpected error: "${err.message}"`);
    return err;
}

// ── In-memory Firestore fake (with queries) ───────────────────────────────────
const INC = Symbol('inc'), DEL = Symbol('del');

function createFakeFirestore() {
    const store = new Map();
    const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

    // Apply a patch the way Firestore would: increments add, deletes remove.
    function applyPatch(base, patch) {
        const out = { ...(base || {}) };
        for (const [k, v] of Object.entries(patch)) {
            if (v && v[INC] !== undefined) out[k] = (Number(out[k]) || 0) + v[INC];
            else if (v && v[DEL]) delete out[k];
            else out[k] = clone(v);
        }
        return out;
    }

    function snap(p) {
        const d = store.get(p);
        return { exists: d !== undefined, id: p.split('/').pop(), ref: docRef(p), data: () => clone(d) };
    }

    function docRef(p) {
        return {
            path: p,
            id: p.split('/').pop(),
            async get() { return snap(p); },
            async set(data, opts) {
                store.set(p, opts && opts.merge ? applyPatch(store.get(p), data) : applyPatch({}, data));
            },
            async update(data) {
                if (!store.has(p)) throw new Error(`update on missing doc ${p}`);
                store.set(p, applyPatch(store.get(p), data));
            },
            async delete() { store.delete(p); },
            collection(sub) { return collectionRef(`${p}/${sub}`); },
        };
    }

    const OPS = {
        '==': (a, b) => a === b,
        'in': (a, b) => b.includes(a),
        '<':  (a, b) => a < b,
        '<=': (a, b) => a <= b,
        '>':  (a, b) => a > b,
        '>=': (a, b) => a >= b,
    };

    function query(base, q = { filters: [], order: null, lim: null, after: null }) {
        const next = (patch) => query(base, { ...q, ...patch });
        return {
            where: (f, op, v) => next({ filters: [...q.filters, [f, op, v]] }),
            orderBy: (f, dir = 'asc') => next({ order: [f, dir] }),
            limit: (n) => next({ lim: n }),
            startAfter: (docSnap) => next({ after: docSnap.id }),
            async get() {
                let docs = [...store.keys()]
                    .filter((k) => k.startsWith(`${base}/`) && !k.slice(base.length + 1).includes('/'))
                    .map(snap)
                    .filter((s) => q.filters.every(([f, op, v]) => OPS[op](s.data()[f], v)));
                if (q.order) {
                    const [f, dir] = q.order;
                    docs.sort((a, b) => (a.data()[f] > b.data()[f] ? 1 : a.data()[f] < b.data()[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
                }
                if (q.after) {
                    const i = docs.findIndex((d) => d.id === q.after);
                    docs = docs.slice(i + 1);
                }
                if (q.lim != null) docs = docs.slice(0, q.lim);
                return { empty: docs.length === 0, size: docs.length, docs };
            },
        };
    }

    function collectionRef(base) {
        return {
            ...query(base),
            doc(id) { return docRef(id ? `${base}/${id}` : `${base}/auto_${crypto.randomBytes(6).toString('hex')}`); },
            async add(data) {
                const p = `${base}/auto_${crypto.randomBytes(6).toString('hex')}`;
                store.set(p, applyPatch({}, data));
                return docRef(p);
            },
        };
    }

    let chain = Promise.resolve();
    function runTransaction(fn) {
        const run = chain.then(async () => {
            const writes = [];
            const txn = {
                async get(ref) { return ref.get(); },
                set(ref, d, o) { writes.push(() => ref.set(d, o)); },
                update(ref, d) { writes.push(() => ref.update(d)); },
                delete(ref)    { writes.push(() => ref.delete()); },
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
        _set: (p, v) => store.set(p, clone(v)),
        _get: (p) => clone(store.get(p)),
        _keys: () => [...store.keys()],
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
            FieldValue: {
                increment: (n) => ({ [INC]: n }),
                delete: () => ({ [DEL]: true }),
                serverTimestamp: () => new Date().toISOString(),
            },
            Timestamp: {
                now:        () => ({ toMillis: () => Date.now() }),
                fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
                fromDate:   (d)  => ({ toMillis: () => d.getTime(), toDate: () => d }),
            },
        };
    }
    if (request === 'firebase-admin/messaging') return { getMessaging: () => ({ send: async () => {} }) };
    if (request === 'firebase-admin/auth') return { getAuth: () => ({}) };
    if (request === 'firebase-functions/v2/https') {
        return { HttpsError, onCall: (o, f) => f || o, onRequest: (o, f) => f || o };
    }
    if (request === 'firebase-functions/v2/firestore') {
        return { onDocumentCreated: (o, f) => f, onDocumentUpdated: (o, f) => f, onDocumentWritten: (o, f) => f };
    }
    if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (o, f) => f };
    if (request === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
    // Side channels these paths call but whose behaviour is not under test.
    if (/(^|\/)notifications$/.test(request)) {
        return { sendNotification: async () => {}, sendArtisanNotification: async () => {} };
    }
    if (/middleware\/rateLimiter$/.test(request)) return { checkRateLimit: async () => {} };
    // Dispatch re-routing runs after the money step in the trigger; not under test.
    if (request === './dispatch') return { handleDispatchEvent: async () => {} };
    return origLoad.apply(this, arguments);
};

// The modules log on load and on every money movement. Keep this file's own
// output (say) and silence theirs, so a failure is not buried in noise.
const say = console.log.bind(console);
console.log = () => {}; console.warn = () => {}; console.error = () => {};

const index       = require(path.join(FN_DIR, 'index.js'));
const escrow      = require(path.join(FN_DIR, 'financial', 'escrow.js'));
const bookings    = require(path.join(FN_DIR, 'bookings.js'));
const autoRelease = require(path.join(FN_DIR, 'financial', 'escrowAutoRelease.js'));
const disputes    = require(path.join(FN_DIR, 'disputes.js'));

const log = say;
async function t(name, fn) {
    try { await fn(); passed++; say(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); say(`  FAIL  ${name}\n        ${e.message}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CUSTOMER = 'cust_1', ARTISAN = 'art_1', OTHER_ARTISAN = 'art_2', STRANGER = 'stranger_1', ADMIN = 'admin_1';
const BOOKING  = 'HHB-261019-1200-TEST';
const ESCROW   = 'esc_job_1';
const CALLOUT  = 'esc_callout_1';

const auth = (uid) => ({ uid, token: { email: `${uid}@example.test` } });
const PAST = new Date(Date.now() - 86400000).toISOString();
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

/** Seed one booking with a held job escrow of 100 (85 artisan / 15 commission). */
function seed({ status = 'accepted', track = 'standard', escrowStatus = 'held', autoReleaseAt = FUTURE,
                calloutEscrow = false, escrowArtisan = ARTISAN, bookingOver = {} } = {}) {
    FAKE_DB._reset();
    FAKE_DB._set(`admins/${ADMIN}`, { userType: 'admin' });
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 400, escrowBalance: 100 + (calloutEscrow ? 50 : 0) });
    FAKE_DB._set(`artisans/${ARTISAN}`, { availableBalance: 0, pendingBalance: 0, totalEarned: 0, jobsCompleted: 0 });
    FAKE_DB._set(`artisans/${OTHER_ARTISAN}`, { availableBalance: 0 });
    FAKE_DB._set(`bookings/${BOOKING}`, {
        customerId: CUSTOMER, artisanId: ARTISAN, status, track, serviceType: 'plumbing', ...bookingOver,
    });
    FAKE_DB._set(`escrow/${ESCROW}`, {
        bookingId: BOOKING, customerId: CUSTOMER, artisanId: escrowArtisan, kind: 'job',
        amount: 100, commission: 15, artisanShare: 85, commissionRate: 0.15,
        status: escrowStatus, autoReleaseAt, createdAt: PAST,
    });
    FAKE_DB._set(`_escrow_locks/${BOOKING}`, {
        bookingId: BOOKING, customerId: CUSTOMER, kind: 'job', escrowId: ESCROW,
        amount: 100, commission: 15, artisanShare: 85,
    });
    if (calloutEscrow) {
        FAKE_DB._set(`escrow/${CALLOUT}`, {
            bookingId: BOOKING, customerId: CUSTOMER, artisanId: ARTISAN, kind: 'callout',
            amount: 50, commission: 7.5, artisanShare: 42.5, commissionRate: 0.15,
            status: 'held', autoReleaseAt, createdAt: PAST,
        });
    }
}

/** Seed an emergency booking whose only escrow is the callout fee (50). */
function seedEmergency({ status = 'accepted' } = {}) {
    FAKE_DB._reset();
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 400, escrowBalance: 50 });
    FAKE_DB._set(`artisans/${ARTISAN}`, { availableBalance: 0, jobsCompleted: 0 });
    FAKE_DB._set(`bookings/${BOOKING}`, {
        customerId: CUSTOMER, artisanId: ARTISAN, status, track: 'emergency', type: 'emergency',
        calloutPaid: true, calloutEscrowId: CALLOUT, calloutFee: 50,
    });
    FAKE_DB._set(`escrow/${CALLOUT}`, {
        bookingId: BOOKING, customerId: CUSTOMER, artisanId: ARTISAN, kind: 'callout',
        amount: 50, commission: 7.5, artisanShare: 42.5, commissionRate: 0.15,
        status: 'held', autoReleaseAt: FUTURE, createdAt: PAST,
    });
}

const esc      = (id = ESCROW) => FAKE_DB._get(`escrow/${id}`);
const cust     = () => FAKE_DB._get(`customers/${CUSTOMER}`);
const art      = () => FAKE_DB._get(`artisans/${ARTISAN}`);
const booking  = () => FAKE_DB._get(`bookings/${BOOKING}`);
const audits   = (action) => FAKE_DB._keys().filter((k) => k.startsWith('financialAudit/'))
    .map((k) => FAKE_DB._get(k)).filter((a) => !action || a.action === action);

/** The escrow did not move and no balance changed. */
function assertUntouched(escrowId = ESCROW, { wallet = 400, held = 100 } = {}) {
    assert.strictEqual(esc(escrowId).status, 'held', 'escrow must still be held');
    assert.strictEqual(cust().walletBalance, wallet, 'customer wallet must be unchanged');
    assert.strictEqual(cust().escrowBalance, held, 'customer escrow balance must be unchanged');
    assert.strictEqual(art().availableBalance || 0, 0, 'artisan must not have been credited');
    assert.strictEqual(audits('escrow_release').length + audits('escrow_refund').length, 0, 'no money movement audited');
}

const call = (fn, uid, data) => fn({ auth: uid ? auth(uid) : null, data });

/** Drive the real onBookingStatusChanged trigger for a status change. */
async function transition(from, to, over = {}) {
    const beforeDoc = { ...booking(), status: from };
    const afterDoc  = { ...booking(), status: to, ...over };
    FAKE_DB._set(`bookings/${BOOKING}`, afterDoc);
    await bookings.onBookingStatusChanged({
        params: { bookingId: BOOKING },
        data: { before: { data: () => beforeDoc }, after: { data: () => afterDoc } },
    });
}

/** Re-deliver exactly the same event (Cloud Functions are at-least-once). */
async function redeliver(from, to) {
    const doc = booking();
    await bookings.onBookingStatusChanged({
        params: { bookingId: BOOKING },
        data: { before: { data: () => ({ ...doc, status: from }) }, after: { data: () => ({ ...doc, status: to }) } },
    });
}

(async () => {

log('\n── Customers and artisans cannot release escrow ──\n');

await t('the customer cannot release their held job escrow', async () => {
    seed({ status: 'in_progress' });
    await rejects(() => call(index.releaseEscrow, CUSTOMER, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

await t('the artisan cannot release a job escrow before the work (booking accepted)', async () => {
    seed({ status: 'accepted' });
    await rejects(() => call(index.releaseEscrow, ARTISAN, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

await t('the artisan cannot release even once the booking is completed', async () => {
    seed({ status: 'completed' });
    await rejects(() => call(index.releaseEscrow, ARTISAN, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

await t('the artisan cannot release the callout fee escrow', async () => {
    seed({ status: 'inspection_scheduled', track: 'inspection', calloutEscrow: true });
    await rejects(() => call(index.releaseEscrow, ARTISAN, { escrowId: CALLOUT }), { code: 'permission-denied' });
    assert.strictEqual(esc(CALLOUT).status, 'held');
    assert.strictEqual(art().availableBalance, 0);
});

await t('a stranger cannot release someone else\'s escrow', async () => {
    seed({ status: 'completed' });
    await rejects(() => call(index.releaseEscrow, STRANGER, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

await t('an unauthenticated call is refused before anything is read', async () => {
    seed({ status: 'completed' });
    await rejects(() => call(index.releaseEscrow, null, { escrowId: ESCROW }), { code: 'unauthenticated' });
    await rejects(() => call(index.refundBooking, null, { escrowId: ESCROW }), { code: 'unauthenticated' });
    assertUntouched();
});

log('\n── Customers and artisans cannot issue refunds ──\n');

await t('the customer cannot refund after the work is done (booking awaiting)', async () => {
    seed({ status: 'awaiting' });
    await rejects(() => call(index.refundBooking, CUSTOMER, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

await t('the customer cannot refund while their own dispute is open (escrow held)', async () => {
    seed({ status: 'disputed' });
    await rejects(() => call(index.refundBooking, CUSTOMER, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

await t('the customer cannot refund a frozen (disputed) escrow', async () => {
    seed({ status: 'disputed', escrowStatus: 'disputed' });
    await rejects(() => call(index.refundBooking, CUSTOMER, { escrowId: ESCROW }), { code: 'permission-denied' });
    assert.strictEqual(esc().status, 'disputed');
    assert.strictEqual(cust().walletBalance, 400);
});

await t('the artisan cannot refund the customer\'s escrow', async () => {
    seed({ status: 'in_progress' });
    await rejects(() => call(index.refundBooking, ARTISAN, { escrowId: ESCROW }), { code: 'permission-denied' });
    assertUntouched();
});

log('\n── The other escrow callables cannot be used to bypass the lifecycle ──\n');

await t('holdBookingFunds is retired: a customer cannot pre-lock a booking', async () => {
    FAKE_DB._reset();
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 400, escrowBalance: 0 });
    await rejects(
        () => call(index.holdBookingFunds, CUSTOMER, { bookingId: 'HHB-OWN', amount: 0.01, artisanId: ARTISAN }),
        { code: 'permission-denied' });
    assert.ok(!FAKE_DB._get('_escrow_locks/HHB-OWN'), 'no lock may be created');
    assert.strictEqual(cust().walletBalance, 400);
});

await t('holdBookingFunds is retired for administrators too', async () => {
    seed();
    await rejects(() => call(index.holdBookingFunds, ADMIN, { bookingId: 'HHB-X', amount: 10 }),
        { code: 'permission-denied' });
});

await t('neither party can freeze escrow directly (raiseDispute is admin-only)', async () => {
    seed({ status: 'in_progress' });
    await rejects(() => call(index.raiseDispute, CUSTOMER, { escrowId: ESCROW }), { code: 'permission-denied' });
    await rejects(() => call(index.raiseDispute, ARTISAN,  { escrowId: ESCROW }), { code: 'permission-denied' });
    assert.strictEqual(esc().status, 'held');
});

await t('an administrator can still freeze a held escrow', async () => {
    seed({ status: 'disputed' });
    await call(index.raiseDispute, ADMIN, { escrowId: ESCROW, disputeId: 'D1' });
    assert.strictEqual(esc().status, 'disputed');
});

log('\n── The primitives are server-only ──\n');

await t('releaseEscrow refuses any caller identity, even an admin\'s', async () => {
    seed({ status: 'completed' });
    for (const uid of [CUSTOMER, ARTISAN, ADMIN]) {
        await rejects(() => escrow.releaseEscrow(ESCROW, { callerAuth: auth(uid) }), { re: /server-only/ });
    }
    assertUntouched();
});

await t('refundEscrow refuses any caller identity, even an admin\'s', async () => {
    seed({ status: 'cancelled' });
    for (const uid of [CUSTOMER, ARTISAN, ADMIN]) {
        await rejects(() => escrow.refundEscrow(ESCROW, { callerAuth: auth(uid) }), { re: /server-only/ });
    }
    assertUntouched();
});

log('\n── Admin repair is bound to the booking\'s terminal state ──\n');

for (const status of ['accepted', 'in_progress', 'awaiting', 'disputed', 'cancelled']) {
    await t(`admin release is refused while the booking is "${status}"`, async () => {
        seed({ status });
        await rejects(() => call(index.releaseEscrow, ADMIN, { escrowId: ESCROW }), { code: 'failed-precondition' });
        assertUntouched();
    });
}

for (const status of ['accepted', 'in_progress', 'awaiting', 'disputed', 'completed']) {
    await t(`admin refund is refused while the booking is "${status}"`, async () => {
        seed({ status });
        await rejects(() => call(index.refundBooking, ADMIN, { escrowId: ESCROW }), { code: 'failed-precondition' });
        assertUntouched();
    });
}

await t('admin release of a completed booking pays the artisan exactly once', async () => {
    seed({ status: 'completed' });
    await call(index.releaseEscrow, ADMIN, { escrowId: ESCROW });
    await rejects(() => call(index.releaseEscrow, ADMIN, { escrowId: ESCROW }), { code: 'failed-precondition' });
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(art().availableBalance, 85);
    assert.strictEqual(cust().escrowBalance, 0);
    assert.strictEqual(cust().walletBalance, 400, 'wallet unchanged by a release');
    assert.strictEqual(audits('escrow_release').length, 1);
    assert.match(esc().releasedBy, /^admin:/);
});

await t('concurrent admin releases still pay exactly once', async () => {
    seed({ status: 'completed' });
    const results = await Promise.allSettled([1, 2, 3].map(() => call(index.releaseEscrow, ADMIN, { escrowId: ESCROW })));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual(art().availableBalance, 85);
    assert.strictEqual(audits('escrow_release').length, 1);
});

await t('admin refund of a cancelled booking refunds exactly once', async () => {
    seed({ status: 'cancelled' });
    await call(index.refundBooking, ADMIN, { escrowId: ESCROW, reason: 'trigger failed' });
    await rejects(() => call(index.refundBooking, ADMIN, { escrowId: ESCROW }), { code: 'failed-precondition' });
    assert.strictEqual(esc().status, 'refunded');
    assert.strictEqual(cust().walletBalance, 500);
    assert.strictEqual(cust().escrowBalance, 0);
    assert.strictEqual(audits('escrow_refund').length, 1);
});

await t('admin cannot settle a callout escrow manually', async () => {
    seed({ status: 'cancelled', track: 'inspection', calloutEscrow: true });
    await rejects(() => call(index.refundBooking, ADMIN, { escrowId: CALLOUT }), { re: /settleCallout/ });
    FAKE_DB._set(`bookings/${BOOKING}`, { ...booking(), status: 'completed' });
    await rejects(() => call(index.releaseEscrow, ADMIN, { escrowId: CALLOUT }), { re: /settleCallout/ });
    assert.strictEqual(esc(CALLOUT).status, 'held');
});

await t('admin release refuses an escrow that names a different artisan than the booking', async () => {
    seed({ status: 'completed', escrowArtisan: OTHER_ARTISAN });
    await rejects(() => call(index.releaseEscrow, ADMIN, { escrowId: ESCROW }), { re: /disagree about the artisan/ });
    assert.strictEqual(FAKE_DB._get(`artisans/${OTHER_ARTISAN}`).availableBalance, 0);
    assert.strictEqual(esc().status, 'held');
});

log('\n── A pre-existing lock can never stand in for the real payment ──\n');

const holdArgs = (amount, customerId = CUSTOMER) => ({
    bookingId: 'HHB-LOCK', customerId, artisanId: ARTISAN, amount, callerAuth: null, kind: 'job',
});

await t('a token pre-lock makes the real hold FAIL instead of passing as paid', async () => {
    FAKE_DB._reset();
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 1000, escrowBalance: 0 });
    await escrow.holdFundsForBooking(holdArgs(0.01));          // the attacker's pre-lock
    await rejects(() => escrow.holdFundsForBooking(holdArgs(500)), { re: /Escrow conflict/ },
        'approveJobQuote must not accept a 0.01 escrow as a 500 payment');
    const escrows = FAKE_DB._keys().filter((k) => k.startsWith('escrow/'));
    assert.strictEqual(escrows.length, 1, 'no second escrow created');
    assert.strictEqual(cust().walletBalance, 999.99, 'only the token amount ever moved');
});

await t('a lock created by a different payer is a conflict, not a replay', async () => {
    FAKE_DB._reset();
    FAKE_DB._set('customers/someone_else', { walletBalance: 1000, escrowBalance: 0 });
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 1000, escrowBalance: 0 });
    await escrow.holdFundsForBooking(holdArgs(500, 'someone_else'));
    await rejects(() => escrow.holdFundsForBooking(holdArgs(500)), { re: /Escrow conflict/ });
    assert.strictEqual(cust().walletBalance, 1000);
});

await t('a genuine retry (same payer, same amount) is still idempotent', async () => {
    FAKE_DB._reset();
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 1000, escrowBalance: 0 });
    const a = await escrow.holdFundsForBooking(holdArgs(500));
    const b = await escrow.holdFundsForBooking(holdArgs(500));
    assert.strictEqual(a.escrowId, b.escrowId);
    assert.strictEqual(cust().walletBalance, 500, 'deducted exactly once');
    assert.strictEqual(cust().escrowBalance, 500);
});

await t('concurrent identical holds deduct exactly once', async () => {
    FAKE_DB._reset();
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance: 1000, escrowBalance: 0 });
    await Promise.all([1, 2, 3, 4].map(() => escrow.holdFundsForBooking(holdArgs(500))));
    assert.strictEqual(cust().walletBalance, 500);
    assert.strictEqual(FAKE_DB._keys().filter((k) => k.startsWith('escrow/')).length, 1);
});

log('\n── The legitimate lifecycle still moves the money ──\n');

await t('completing a booking releases its job escrow, once, even if the event repeats', async () => {
    seed({ status: 'awaiting' });
    await transition('awaiting', 'completed');
    await redeliver('awaiting', 'completed');
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(art().availableBalance, 85);
    assert.strictEqual(cust().escrowBalance, 0);
    assert.strictEqual(audits('escrow_release').length, 1);
});

await t('cancelling a booking refunds its job escrow, once, even if the event repeats', async () => {
    seed({ status: 'accepted' });
    await transition('accepted', 'cancelled');
    await redeliver('accepted', 'cancelled');
    assert.strictEqual(esc().status, 'refunded');
    assert.strictEqual(cust().walletBalance, 500);
    assert.strictEqual(cust().escrowBalance, 0);
    assert.strictEqual(audits('escrow_refund').length, 1);
});

await t('contradictory concurrent events (complete + cancel) move the money exactly once', async () => {
    seed({ status: 'awaiting' });
    const doc = booking();
    const ev = (to) => ({
        params: { bookingId: BOOKING },
        data: { before: { data: () => ({ ...doc, status: 'awaiting' }) }, after: { data: () => ({ ...doc, status: to }) } },
    });
    await Promise.all([bookings.onBookingStatusChanged(ev('completed')), bookings.onBookingStatusChanged(ev('cancelled'))]);
    const moved = audits('escrow_release').length + audits('escrow_refund').length;
    assert.strictEqual(moved, 1, 'exactly one settlement');
    const total = cust().walletBalance + cust().escrowBalance + (art().availableBalance || 0);
    assert.ok(total === 500 || total === 485, `money conserved (wallet+escrow+artisan = ${total})`);
});

await t('cancelling an emergency booking refunds its callout fee server-side', async () => {
    seedEmergency({ status: 'accepted' });
    await transition('accepted', 'cancelled');
    await redeliver('accepted', 'cancelled');
    assert.strictEqual(esc(CALLOUT).status, 'refunded', 'the trigger must refund the emergency fee');
    assert.strictEqual(cust().walletBalance, 450);
    assert.strictEqual(cust().escrowBalance, 0);
    assert.strictEqual(booking().calloutSettled, 'refunded');
    assert.strictEqual(audits('escrow_refund').length, 1, 'refunded once');
});

await t('a booking moving to "disputed" moves no money', async () => {
    seed({ status: 'awaiting' });
    await transition('awaiting', 'disputed');
    assertUntouched();
});

log('\n── The scheduler leaves disputes to an administrator ──\n');

await t('an expired escrow on a disputed booking is held, not auto-refunded', async () => {
    seed({ status: 'disputed', autoReleaseAt: PAST });
    await autoRelease.runAutoRelease();
    assertUntouched();
});

await t('an expired escrow on an awaiting booking is still auto-released', async () => {
    seed({ status: 'awaiting', autoReleaseAt: PAST });
    await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(art().availableBalance, 85);
});

await t('an expired escrow on an abandoned booking is still auto-refunded', async () => {
    seed({ status: 'accepted', autoReleaseAt: PAST });
    await autoRelease.runAutoRelease();
    assert.strictEqual(esc().status, 'refunded');
    assert.strictEqual(cust().walletBalance, 500);
});

log('\n── Administrator dispute resolution still works ──\n');

await t('resolveDispute full_refund refunds the customer once', async () => {
    seed({ status: 'disputed' });
    await disputes.resolveDispute(auth(ADMIN), { bookingId: BOOKING, resolution: 'full_refund', notes: 'no-show' });
    assert.strictEqual(esc().status, 'refunded');
    assert.strictEqual(cust().walletBalance, 500);
    assert.strictEqual(booking().status, 'resolved');
    await rejects(() => disputes.resolveDispute(auth(ADMIN), { bookingId: BOOKING, resolution: 'full_refund', notes: 'again' }),
        { re: /not currently disputed/ });
    assert.strictEqual(audits('escrow_refund').length, 1);
});

await t('resolveDispute release_artisan pays the artisan once', async () => {
    seed({ status: 'disputed' });
    await disputes.resolveDispute(auth(ADMIN), { bookingId: BOOKING, resolution: 'release_artisan', notes: 'work verified' });
    assert.strictEqual(esc().status, 'released');
    assert.strictEqual(art().availableBalance, 85);
});

await t('resolveDispute refuses a customer or artisan', async () => {
    seed({ status: 'disputed' });
    for (const uid of [CUSTOMER, ARTISAN]) {
        await rejects(() => disputes.resolveDispute(auth(uid), { bookingId: BOOKING, resolution: 'full_refund', notes: 'x' }),
            { re: /admin access only/ });
    }
    assertUntouched();
});

log('\n── No app asks for escrow to move ──\n');

await t('no customer, artisan or admin page calls the escrow callables', async () => {
    const CALLABLES = /\b(releaseEscrow|refundBooking|holdBookingFunds|raiseDispute)\s*\(/;
    const offenders = [];
    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue; }
            if (!/\.(html|js)$/.test(ent.name)) continue;
            const rel = path.relative(ROOT, p).replace(/\\/g, '/');
            // walletService defines the wrappers; defining is not calling.
            if (rel === 'shared/js/services/walletService.js') continue;
            fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
                if (/^\s*(\/\/|\*)/.test(line)) return;
                if (CALLABLES.test(line)) offenders.push(`${rel}:${i + 1}`);
            });
        }
    };
    for (const d of ['customer-app', 'artisan-app', 'admin-dashboard', 'shared/js']) walk(path.join(ROOT, d));
    assert.deepStrictEqual(offenders, [], `client code still calls an escrow callable:\n  ${offenders.join('\n  ')}`);
});

say(`\nescrow-authorization: ${passed} passed, ${failed} failed`);
if (failed) {
    for (const [name, e] of failures) say(`\n✗ ${name}\n${e.stack}`);
    process.exit(1);
}
})();
