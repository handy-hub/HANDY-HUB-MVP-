'use strict';

/**
 * functions/locationRetention.js — how long an artisan sees where a customer
 * lives: until 14 days after the booking closes (decision Q6, 2026-11-06).
 *
 * The artisan reads the booking document itself (firestore.rules: the booking's
 * artisanId may read it), and rules cannot hide single fields. So the exact
 * location MOVES: 14 days after a booking closes, its address, lat, lng and
 * notes (the customer's directions) go to bookings/{id}/private/location, which
 * only the customer and administrators can read, and leave the booking. The job
 * record the artisan keeps (service, description, photos, money, dates) is
 * untouched. Nothing replaces the location: no area or neighbourhood label is
 * derived from it.
 *
 *   stampRetention(bookingId, before, after)   onBookingStatusChanged, on close:
 *                                              locationRetainUntilMs = now + 14 days
 *   moveExpiredLocations()                     checkBookingTimeouts (hourly): moves
 *                                              every booking whose time has come
 *   backfillRetention(mode, pageSize, report)  adminMigrateContactPrivacy step for
 *                                              bookings closed before this existed,
 *                                              and for the address that appointment
 *                                              reminders used to carry
 *
 * Moving is idempotent and never overwrites a private copy that already exists.
 * locationRetainUntilMs and locationRemovedAt are server-only booking fields
 * (bookingSystemFields in firestore.rules).
 */

const { FieldValue, FieldPath } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const RETENTION_DAYS  = 14;
const RETENTION_MS    = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const LOCATION_FIELDS = Object.freeze(['address', 'lat', 'lng', 'notes']);
const CLOSED_STATUSES = Object.freeze(['completed', 'cancelled', 'resolved', 'rejected', 'unfulfilled']);
const MOVE_BATCH      = 100;
const nowIso = () => new Date().toISOString();

const isClosed    = (status) => CLOSED_STATUSES.includes(String(status || '').toLowerCase());
const hasLocation = (b) => LOCATION_FIELDS.some((f) => b[f] !== undefined && b[f] !== null && b[f] !== '');

/** When the booking closed, from the record (ms), or null. */
function closedAtMs(b) {
    for (const f of ['completedAt', 'cancelledAt', 'resolvedAt', 'updatedAt']) {
        const v = b[f];
        const ms = v && typeof v.toMillis === 'function' ? v.toMillis() : Date.parse(v);
        if (Number.isFinite(ms)) return ms;
    }
    return null;
}

/**
 * Start the 14 days when a booking an artisan could read closes. Called by
 * onBookingStatusChanged; the write is metadata-only, so the trigger's own
 * "status unchanged" guard stops it there.
 */
async function stampRetention(bookingId, before, after, nowMs = Date.now()) {
    if (!isClosed(after.status) || isClosed(before.status)) return false;
    if (!after.artisanId || !hasLocation(after) || after.locationRetainUntilMs) return false;
    await db().collection('bookings').doc(bookingId).update({ locationRetainUntilMs: nowMs + RETENTION_MS });
    return true;
}

/** Move one booking's location to private/location, in one transaction. */
async function moveOne(ref, nowMs) {
    const privRef = ref.collection('private').doc('location');
    return db().runTransaction(async (txn) => {
        const [live, priv] = await Promise.all([txn.get(ref), txn.get(privRef)]);
        if (!live.exists) return 'gone';
        const b = live.data();
        if (!(Number(b.locationRetainUntilMs) <= nowMs)) return 'not_due';
        if (!isClosed(b.status)) {
            // Reopened since it was stamped: the artisan needs it again. Clear the
            // clock; closing again starts a new one.
            txn.update(ref, { locationRetainUntilMs: FieldValue.delete() });
            return 'reopened';
        }
        const kept = priv.exists ? priv.data() : {};
        const copy = {};
        const strip = { locationRetainUntilMs: FieldValue.delete(), locationRemovedAt: nowIso() };
        for (const f of LOCATION_FIELDS) {
            if (b[f] === undefined) continue;
            if (kept[f] === undefined) copy[f] = b[f];   // never overwrites the private copy
            strip[f] = FieldValue.delete();
        }
        txn.set(privRef, {
            ...copy,
            bookingId:  ref.id,
            customerId: b.customerId || kept.customerId || null,
            movedAt:    kept.movedAt || nowIso(),
            reason:     'retention_14_days_after_close',
        }, { merge: true });
        txn.update(ref, strip);
        return 'moved';
    });
}

/**
 * Move every booking whose 14 days have passed. Runs inside the hourly
 * checkBookingTimeouts (no new deployed function — CPU budget).
 */
async function moveExpiredLocations({ nowMs = Date.now(), limit = MOVE_BATCH } = {}) {
    const snap = await db().collection('bookings')
        .where('locationRetainUntilMs', '<=', nowMs).limit(limit).get();
    const out = { moved: 0, reopened: 0, skipped: 0, failed: 0 };
    for (const doc of snap.docs) {
        try {
            const r = await moveOne(doc.ref, nowMs);
            if (r === 'moved') out.moved++;
            else if (r === 'reopened') out.reopened++;
            else out.skipped++;
        } catch (err) {
            out.failed++;
            console.error(`[locationRetention] Move failed booking=${doc.id}:`, err.message);
        }
    }
    if (out.moved || out.failed) console.log(`[locationRetention] moved=${out.moved} failed=${out.failed} reopened=${out.reopened}`);
    return out;
}

// What appointment reminders appended before they stopped carrying the address.
const REMINDER_TITLE   = 'Appointment coming up';
const REMINDER_ADDRESS = /\s*Address: .*$/s;

/**
 * For records written before this: stamp closed bookings (the hourly sweep then
 * moves any whose 14 days are already over), and drop the address from old
 * appointment reminders. Same modes as functions/contactPrivacy.js: 'dry-run'
 * reports and writes nothing; 'copy' and 'strip' write. Ids and counts only.
 */
async function backfillRetention(mode, pageSize, report, nowMs = Date.now()) {
    const r = report.bookingLocations = { closedWithLocation: 0, stamped: 0, dueNow: 0, reminders: 0, remindersCleaned: 0, ids: [] };
    const write = mode !== 'dry-run';

    let last = null;
    for (;;) {
        let q = db().collection('bookings').orderBy(FieldPath.documentId()).limit(pageSize);
        if (last) q = q.startAfter(last);
        const page = await q.get();
        if (page.empty) break;
        for (const doc of page.docs) {
            const b = doc.data();
            if (!isClosed(b.status) || !b.artisanId || !hasLocation(b) || b.locationRetainUntilMs || b.locationRemovedAt) continue;
            r.closedWithLocation++;
            const until = (closedAtMs(b) ?? nowMs) + RETENTION_MS;
            if (until <= nowMs) r.dueNow++;
            r.ids.push(doc.id);
            if (write) { await doc.ref.update({ locationRetainUntilMs: until }); r.stamped++; }
        }
        last = page.docs[page.docs.length - 1].id;
        if (page.docs.length < pageSize) break;
    }

    const reminders = await db().collection('customer_notifications').where('title', '==', REMINDER_TITLE).get();
    for (const doc of reminders.docs) {
        const msg = String(doc.data().message || '');
        if (!REMINDER_ADDRESS.test(msg)) continue;
        r.reminders++;
        if (write) { await doc.ref.update({ message: msg.replace(REMINDER_ADDRESS, '') }); r.remindersCleaned++; }
    }
    return r;
}

module.exports = {
    RETENTION_DAYS, RETENTION_MS, LOCATION_FIELDS, CLOSED_STATUSES,
    stampRetention, moveExpiredLocations, backfillRetention, closedAtMs,
};
