'use strict';

/**
 * tests/emergency-pricing.test.cjs — emergency callout money invariants.
 *
 * Run: node tests/emergency-pricing.test.cjs
 *
 * WHAT THIS PROTECTS
 * ──────────────────
 * Emergency bookings charged nobody. The page read `d.callOutFee` off the
 * ARTISAN document — a field artisans do not have (they carry baseRate) — so
 * the amount was always undefined, the escrow branch was never entered, and
 * every emergency job completed for free. Fixing the spelling alone would NOT
 * have fixed it, because no artisan-side fee exists at all.
 *
 * These tests target the ways that class of bug returns:
 *
 *   • a missing or malformed fee silently becoming 0 / NaN / a fallback
 *   • the client being able to influence what it is charged
 *   • booking, escrow and receipt disagreeing about the amount
 *   • a failed hold leaving a booking marked paid
 *   • standard pricing drifting while emergency pricing is changed
 *
 * Firestore is an in-memory fake whose runTransaction serialises, matching the
 * harness in topup-charge.test.cjs.
 */

const assert = require('assert');
const path   = require('path');
const crypto = require('crypto');
const Module = require('module');

// ── Harness ───────────────────────────────────────────────────────────────────
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
        failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
}

async function rejects(fn, re, msg) {
    try { await fn(); }
    catch (e) {
        if (re && !re.test(e.message)) throw new Error(`${msg || 'wrong error'}: got "${e.message}"`);
        return e;
    }
    throw new Error(msg || 'expected a rejection, got none');
}

// ── In-memory Firestore fake ──────────────────────────────────────────────────
function createFakeFirestore() {
    const store = new Map();
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
        _set: (p, v) => store.set(p, v),
        _get: (p) => store.get(p),
        _has: (p) => store.has(p),
        _keys: () => [...store.keys()],
        _reset() { store.clear(); chain = Promise.resolve(); },
    };
}

// ── Module interception ───────────────────────────────────────────────────────
const FN_DIR  = path.join(__dirname, '..', 'functions');
const FAKE_DB = createFakeFirestore();

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'firebase-admin/firestore') {
        return {
            getFirestore: () => FAKE_DB,
            FieldValue: { increment: (n) => ({ __inc: n }) },
            Timestamp: {
                now:        () => ({ toMillis: () => Date.now() }),
                fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
                fromDate:   (d)  => ({ toMillis: () => d.getTime(), toDate: () => d }),
            },
        };
    }
    if (request === 'firebase-functions/v2/https') {
        class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
        return { HttpsError, onCall: () => {} };
    }
    if (request === 'firebase-functions/v2/firestore') return { onDocumentCreated: () => {}, onDocumentUpdated: () => {} };
    if (request === 'firebase-functions/v2/scheduler') return { onSchedule: () => {} };
    return origLoad.apply(this, arguments);
};

const pricing = require(path.join(FN_DIR, 'pricing.js'));
const escrow  = require(path.join(FN_DIR, 'financial', 'escrow.js'));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const CUSTOMER = 'cust_emergency_1';
const ARTISAN  = 'art_emergency_1';
// Accra centre, and a point ~8 km away for the travel-band tests.
const ACCRA    = { lat: 5.6037, lng: -0.1870 };
const FAR      = { lat: 5.6757, lng: -0.1870 };   // ~8 km north

function seedBase({ walletBalance = 5000, artisanAt = null, config = null } = {}) {
    FAKE_DB._reset();
    FAKE_DB._set(`customers/${CUSTOMER}`, { walletBalance, escrowBalance: 0, spent: 0 });
    if (artisanAt) FAKE_DB._set(`artisan_index/${ARTISAN}`, { lat: artisanAt.lat, lng: artisanAt.lng });
    if (config)    FAKE_DB._set('pricing_config/plumbing', config);
}

function seedEmergencyBooking(id, over = {}) {
    FAKE_DB._set(`bookings/${id}`, {
        customerId: CUSTOMER, artisanId: ARTISAN,
        track: 'emergency', type: 'emergency', isEmergency: true,
        status: 'pending', serviceType: 'plumbing',
        lat: ACCRA.lat, lng: ACCRA.lng,
        ...over,
    });
}

const AUTH = { uid: CUSTOMER };

(async () => {
console.log('\n── The callout formula (shared by both tracks) ──\n');

const CFG = { inspectionFeeGHS: 50, emergencyCalloutGHS: 80, perKmGHS: 2.5,
              freeRadiusKm: 3, maxTravelGHS: 60, flatTravelGHS: 10, maxCalloutGHS: 150 };

test('standard base + flat travel = 60', () => {
    assert.strictEqual(pricing.applyCalloutFormula(CFG, 50, 10), 60);
});
test('emergency base + flat travel = 90', () => {
    assert.strictEqual(pricing.applyCalloutFormula(CFG, 80, 10), 90);
});
test('fractional travel rounds UP to a whole cedi', () => {
    assert.strictEqual(pricing.applyCalloutFormula(CFG, 80, 12.5), 93);
});
test('the cap holds — never above maxCalloutGHS', () => {
    assert.strictEqual(pricing.applyCalloutFormula(CFG, 80, 999), 150);
});

console.log('\n── Emergency pricing is server-computed ──\n');

await test('no artisan position -> configured flat travel, never 0', async () => {
    seedBase();
    const p = await pricing.computeEmergencyCallout({ category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN });
    assert.strictEqual(p.travelFee, 10, 'flat travel expected');
    assert.strictEqual(p.calloutFee, 90);
    assert.strictEqual(p.travelEstimated, true);
});

await test('artisan inside the free radius -> no travel component', async () => {
    seedBase({ artisanAt: ACCRA });
    const p = await pricing.computeEmergencyCallout({ category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN });
    assert.strictEqual(p.travelFee, 0);
    assert.strictEqual(p.calloutFee, 80, 'emergency base only');
    assert.strictEqual(p.travelEstimated, false);
});

await test('distant artisan -> travel added and billed above the base', async () => {
    seedBase({ artisanAt: FAR });
    const p = await pricing.computeEmergencyCallout({ category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN });
    assert.ok(p.travelFee > 0, `expected travel > 0, got ${p.travelFee}`);
    assert.ok(p.calloutFee > 80, `expected callout > base, got ${p.calloutFee}`);
    assert.strictEqual(p.travelEstimated, false);
});

await test('pricing_config overrides the code default without a deploy', async () => {
    seedBase({ artisanAt: ACCRA, config: { emergencyCalloutGHS: 120 } });
    const p = await pricing.computeEmergencyCallout({ category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN });
    assert.strictEqual(p.calloutFee, 120);
});

console.log('\n── A bad fee must NEVER become a silent charge ──\n');

// loadPricingConfig sanitises before this code ever sees the value. A negative
// or non-finite override is REJECTED there and the code default stands, while 0
// (and null, which coerces to 0) is a legitimate number and must then be refused
// here. Both routes are safe; the invariant that matters is that NEITHER can
// produce a zero, NaN or undefined charge.
for (const [label, bad] of [['zero', 0], ['null', null]]) {
    await test(`config emergencyCalloutGHS = ${label} -> refuses to price`, async () => {
        seedBase({ artisanAt: ACCRA, config: { emergencyCalloutGHS: bad } });
        await rejects(
            () => pricing.computeEmergencyCallout({ category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN }),
            /not configured|invalid amount/i,
            'must refuse rather than charge zero',
        );
    });
}

// Infinity is deliberately absent: Firestore cannot store it, so it is not a
// state this config can reach in production.
for (const [label, bad] of [['negative', -5], ['non-numeric', 'abc']]) {
    await test(`config emergencyCalloutGHS = ${label} -> falls back to the safe default`, async () => {
        seedBase({ artisanAt: ACCRA, config: { emergencyCalloutGHS: bad } });
        const p = await pricing.computeEmergencyCallout({ category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN });
        assert.strictEqual(p.calloutFee, 80, 'code default must stand');
        assert.ok(Number.isFinite(p.calloutFee) && p.calloutFee > 0, 'never 0 or NaN');
    });
}

console.log('\n── Payment authority: the client cannot name the amount ──\n');

await test('payEmergencyCallout escrows the BOOKING fee, ignoring client input', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK1', { calloutFee: 80 });
    // A hostile caller passing its own amount — the signature has no such field.
    const r = await pricing.payEmergencyCallout(AUTH, { bookingId: 'BK1', amount: 1, calloutFee: 1 });
    assert.strictEqual(r.amount, 80, 'server fee must win');

    const esc = FAKE_DB._keys().filter((k) => k.startsWith('escrow/')).map((k) => FAKE_DB._get(k));
    assert.strictEqual(esc.length, 1, 'exactly one escrow record');
    assert.strictEqual(esc[0].amount, 80, 'escrow stores the server amount');
});

await test('booking, escrow and receipt all agree on the amount', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK2', { calloutFee: 93 });
    const r = await pricing.payEmergencyCallout(AUTH, { bookingId: 'BK2' });

    const bk  = FAKE_DB._get('bookings/BK2');
    const esc = FAKE_DB._get(FAKE_DB._keys().find((k) => k.startsWith('escrow/')));

    assert.strictEqual(bk.calloutFee, 93,          'booking amount');
    assert.strictEqual(esc.amount,    93,          'escrow amount');
    assert.strictEqual(r.amount,      93,          'returned amount');
    assert.strictEqual(bk.calloutPaid, true,       'marked paid');
    assert.strictEqual(bk.calloutEscrowId, r.escrowId, 'escrow id recorded on the booking');

    // The receipt reads exactly these fields (bookingTruth.resolveMoney).
    const { resolveMoney } = await import('file:///' +
        path.join(__dirname, '..', 'shared', 'js', 'domain', 'bookingTruth.js').replace(/\\/g, '/'));
    const money = resolveMoney(bk);
    assert.strictEqual(money.calloutFee,     93, 'receipt fee');
    assert.strictEqual(money.calloutCharged, 93, 'receipt charged');
});

await test('an unpriced booking is refused, not charged zero', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK3');                       // no calloutFee stamped
    await rejects(() => pricing.payEmergencyCallout(AUTH, { bookingId: 'BK3' }), /not ready/i);
    assert.strictEqual(FAKE_DB._keys().some((k) => k.startsWith('escrow/')), false, 'no escrow created');
    assert.notStrictEqual(FAKE_DB._get('bookings/BK3').calloutPaid, true, 'not marked paid');
});

await test('a zero fee is refused', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK4', { calloutFee: 0 });
    await rejects(() => pricing.payEmergencyCallout(AUTH, { bookingId: 'BK4' }), /not ready/i);
});

await test('another customer cannot pay for this booking', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK5', { calloutFee: 80 });
    await rejects(() => pricing.payEmergencyCallout({ uid: 'someone_else' }, { bookingId: 'BK5' }), /not authorised/i);
});

await test('a standard booking cannot be paid through the emergency path', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK6', { calloutFee: 80, track: 'standard' });
    await rejects(() => pricing.payEmergencyCallout(AUTH, { bookingId: 'BK6' }), /not an emergency/i);
});

await test('paying twice holds once (idempotent)', async () => {
    seedBase({ artisanAt: ACCRA });
    seedEmergencyBooking('BK7', { calloutFee: 80 });
    const a = await pricing.payEmergencyCallout(AUTH, { bookingId: 'BK7' });
    const b = await pricing.payEmergencyCallout(AUTH, { bookingId: 'BK7' });
    assert.strictEqual(b.alreadyPaid, true);
    assert.strictEqual(b.escrowId, a.escrowId, 'same escrow returned');
    const wallet = FAKE_DB._get(`customers/${CUSTOMER}`);
    assert.strictEqual(wallet.walletBalance, 5000 - 80, 'deducted exactly once');
});

await test('a failed hold leaves the booking UNPAID', async () => {
    seedBase({ walletBalance: 5, artisanAt: ACCRA });   // cannot cover GHS 80
    seedEmergencyBooking('BK8', { calloutFee: 80 });
    await rejects(() => pricing.payEmergencyCallout(AUTH, { bookingId: 'BK8' }), /.*/);
    const bk = FAKE_DB._get('bookings/BK8');
    assert.notStrictEqual(bk.calloutPaid, true, 'must not be marked paid');
    assert.strictEqual(bk.calloutEscrowId, undefined, 'no escrow id recorded');
});

console.log('\n── Standard pricing must be unchanged ──\n');

await test('standard callout still GHS 50 + travel (emergency fix did not touch it)', async () => {
    seedBase({ artisanAt: ACCRA });
    const q = await pricing.getPricingQuote(AUTH, {
        category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN,
    });
    assert.strictEqual(q.inspectionFee, 50, 'base unchanged');
    assert.strictEqual(q.travelFee, 0,      'inside free radius');
    assert.strictEqual(q.calloutFee, 50,    'standard total unchanged');
});

await test('standard with travel is unchanged', async () => {
    seedBase({ artisanAt: FAR });
    const q = await pricing.getPricingQuote(AUTH, {
        category: 'plumbing', lat: ACCRA.lat, lng: ACCRA.lng, artisanId: ARTISAN,
    });
    assert.strictEqual(q.inspectionFee, 50);
    assert.ok(q.travelFee > 0, 'travel applied');
    assert.strictEqual(q.calloutFee, Math.ceil(Math.min(50 + q.travelFee, 150)));
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nemergency-pricing: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log('\nFailures:');
    failures.forEach(([n, e]) => console.log(`  ${n}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`));
}
process.exit(failed ? 1 : 0);
})();
