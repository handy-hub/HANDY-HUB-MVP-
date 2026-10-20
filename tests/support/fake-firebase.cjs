'use strict';

/**
 * tests/support/fake-firebase.cjs — an in-memory stand-in for the parts of
 * firebase-admin and firebase-functions that Cloud Functions modules touch, so
 * the REAL functions/*.js code runs with no network, emulator or credentials.
 *
 * Firestore model:
 *   • documents keyed by path; nested collections via doc.collection(name)
 *   • runTransaction runs one transaction at a time. Firestore guarantees a
 *     serialisable outcome (it retries a transaction whose reads changed), so a
 *     serial schedule is a faithful model of the final state of concurrent
 *     transactions — including the "second one re-reads and sees the first's
 *     commit" case the funding tests depend on.
 *   • a transaction's writes are applied only after its callback resolves: a
 *     callback that throws leaves NOTHING behind, exactly as a failed commit.
 *   • FieldValue.increment / delete / serverTimestamp are honoured on write.
 *
 * Messaging model: getMessaging().send() records each message; a test can make
 * the next send fail with a given error code.
 *
 * Usage (before requiring any functions/ module):
 *   const fake = require('./support/fake-firebase.cjs').install();
 *   fake.db._set('customers/c1', { walletBalance: 100 });
 */

const crypto = require('crypto');
const Module = require('module');

const INC = Symbol('increment');
const DEL = Symbol('delete');
const TS  = Symbol('serverTimestamp');

const FieldValue = {
    increment:       (n) => ({ [INC]: n }),
    delete:          () => ({ [DEL]: true }),
    serverTimestamp: () => ({ [TS]: true }),
    arrayUnion:      (...items) => ({ __arrayUnion: items }),
};

function makeTimestamp(ms) {
    return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), nanoseconds: 0 };
}
const Timestamp = {
    now:        () => makeTimestamp(Date.now()),
    fromMillis: (ms) => makeTimestamp(ms),
    fromDate:   (d)  => makeTimestamp(d.getTime()),
};

function applyFields(existing, patch) {
    const out = { ...(existing || {}) };
    for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && v[DEL]) { delete out[k]; continue; }
        if (v && typeof v === 'object' && INC in v) { out[k] = Number(out[k] || 0) + v[INC]; continue; }
        if (v && typeof v === 'object' && v[TS]) { out[k] = new Date().toISOString(); continue; }
        if (v && typeof v === 'object' && Array.isArray(v.__arrayUnion)) {
            const cur = Array.isArray(out[k]) ? out[k] : [];
            out[k] = [...cur, ...v.__arrayUnion.filter((x) => !cur.includes(x))];
            continue;
        }
        out[k] = v;
    }
    return out;
}

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

function createFakeFirestore() {
    const store = new Map();
    let writes = 0;

    function snapshot(p) {
        const d = store.get(p);
        return { exists: d !== undefined, id: p.split('/').pop(), ref: docRef(p), data: () => clone(d) };
    }
    function docRef(p) {
        return {
            path: p,
            id: p.split('/').pop(),
            async get() { return snapshot(p); },
            async set(data, opts) { writes++; store.set(p, opts && opts.merge ? applyFields(store.get(p), data) : applyFields({}, data)); },
            async update(data) {
                if (!store.has(p)) { const e = new Error(`No document to update: ${p}`); e.code = 5; throw e; }
                writes++; store.set(p, applyFields(store.get(p), data));
            },
            async delete() { writes++; store.delete(p); },
            collection(sub) { return collectionRef(`${p}/${sub}`); },
        };
    }
    function collectionRef(base) {
        return {
            doc(id) { return docRef(`${base}/${id || `auto_${crypto.randomBytes(6).toString('hex')}`}`); },
            async add(data) { const r = this.doc(); await r.set(data); return r; },
        };
    }

    let chain = Promise.resolve();
    function runTransaction(fn) {
        const run = chain.then(async () => {
            const staged = [];
            const txn = {
                async get(ref) { return snapshot(ref.path); },
                set(ref, d, o)  { staged.push({ op: 'set', ref, d, o }); return txn; },
                update(ref, d)  { staged.push({ op: 'update', ref, d });  return txn; },
                delete(ref)     { staged.push({ op: 'delete', ref });     return txn; },
            };
            const result = await fn(txn);
            // All or nothing: Firestore refuses the whole commit if any update
            // targets a document that will not exist — validate before applying.
            const willExist = new Set();
            for (const w of staged) {
                if (w.op === 'set') willExist.add(w.ref.path);
                else if (w.op === 'delete') willExist.delete(w.ref.path);
                else if (!store.has(w.ref.path) && !willExist.has(w.ref.path)) {
                    const e = new Error(`No document to update: ${w.ref.path}`); e.code = 5; throw e;
                }
            }
            for (const w of staged) {
                if (w.op === 'set') await w.ref.set(w.d, w.o);
                else if (w.op === 'update') await w.ref.update(w.d);
                else await w.ref.delete();
            }
            return result;
        });
        chain = run.catch(() => {});
        return run;
    }

    return {
        collection: (n) => collectionRef(n),
        doc: (p) => docRef(p),
        runTransaction,
        _set: (p, v) => store.set(p, clone(v)),
        _get: (p) => clone(store.get(p)),
        _has: (p) => store.has(p),
        _keys: (prefix = '') => [...store.keys()].filter((k) => k.startsWith(prefix)),
        _writes: () => writes,
        _reset() { store.clear(); chain = Promise.resolve(); writes = 0; },
    };
}

function createFakeMessaging() {
    const sent = [];
    let nextError = null;
    return {
        sent,
        failNextWith(code, message = code) { nextError = Object.assign(new Error(message), { code }); },
        async send(message) {
            if (nextError) { const e = nextError; nextError = null; throw e; }
            sent.push(JSON.parse(JSON.stringify(message)));
            return `projects/test/messages/${sent.length}`;
        },
        _reset() { sent.length = 0; nextError = null; },
    };
}

/** Intercept firebase-admin / firebase-functions requires. Call once per process. */
function install() {
    const db = createFakeFirestore();
    const messaging = createFakeMessaging();
    const origLoad = Module._load;
    Module._load = function (request) {
        if (request === 'firebase-admin/firestore') {
            return { getFirestore: () => db, FieldValue, Timestamp, FieldPath: { documentId: () => '__name__' } };
        }
        if (request === 'firebase-admin/messaging') return { getMessaging: () => messaging };
        if (request === 'firebase-admin/app') return { initializeApp: () => ({}), getApps: () => [] };
        if (request === 'firebase-functions/v2/https') {
            class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
            return { HttpsError, onCall: (o, h) => h || o, onRequest: (o, h) => h || o };
        }
        if (request === 'firebase-functions/v2/firestore') {
            const t = (o, h) => h || o;
            return { onDocumentCreated: t, onDocumentUpdated: t, onDocumentWritten: t };
        }
        if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (o, h) => h || o };
        return origLoad.apply(this, arguments);
    };
    return { db, messaging, FieldValue, Timestamp };
}

module.exports = { install, createFakeFirestore, createFakeMessaging };
