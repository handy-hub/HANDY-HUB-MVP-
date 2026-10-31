'use strict';

/**
 * functions/contactPrivacy.js — move the data AR-03 and AR-06 took off public
 * documents, for records written before 2026-10-20.
 *
 *   artisans/{id}           precise position (currentLat/currentLng/lat/lng/
 *                           latitude/longitude/geohash/locationAccuracy)
 *                           → artisans/{id}/private/location; the profile keeps
 *                           a ~1 km copy (shared/js/domain/locationPrivacy.js).
 *   bookings/{id}           customerPhone → bookings/{id}/private/contact.
 *   bookings/{id}           the ARTISAN's phone copied by clients (proPhone,
 *                           artisanPhone, artisan.phone, professional.phone)
 *                           → bookings/{id}/private/artisanContact (CONTACT-001).
 *
 * New writes already go to the private records; this moves what is already
 * there. Same contract as functions/artisanPrivacy.js:
 *
 *   'dry-run'  (default) report what would change; write nothing.
 *   'copy'     create the private record where it is missing. Never overwrites
 *              an existing private record — it is newer than the legacy copy.
 *   'strip'    copy anything still missing, then coarsen / remove the public
 *              fields — each document in its own transaction, and only once its
 *              private record holds the value, so nothing can be lost.
 *
 * Reports carry document ids and counts only, never coordinates or numbers.
 * NOT run automatically: an administrator runs it once, after deploying.
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

const MODES = new Set(['dry-run', 'copy', 'strip']);
const nowIso = () => new Date().toISOString();

// Mirrors coarseCoord / isCoarse in shared/js/domain/locationPrivacy.js.
const coarse   = (v) => Math.round(Number(v) * 100) / 100;
const isNum    = (v) => typeof v === 'number' && Number.isFinite(v);
const isCoarse = (v) => !isNum(v) || Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

/** The precise position a legacy profile holds, or null. */
function legacyPosition(d) {
    const lat = isNum(d.currentLat) ? d.currentLat : isNum(d.lat) ? d.lat : isNum(d.latitude) ? d.latitude : null;
    const lng = isNum(d.currentLng) ? d.currentLng : isNum(d.lng) ? d.lng : isNum(d.longitude) ? d.longitude : null;
    return lat !== null && lng !== null ? { lat, lng } : null;
}

/** Does this profile still expose more than public precision? */
function exposesLocation(d) {
    return ['lat', 'lng', 'latitude', 'longitude'].some((k) => isNum(d[k]) && !isCoarse(d[k])) ||
           isNum(d.currentLat) || isNum(d.currentLng) || isNum(d.locationAccuracy) ||
           (typeof d.geohash === 'string' && d.geohash.length > 5);
}

/** The public patch that leaves only ~1 km precision. */
function publicLocationPatch(d) {
    const patch = { currentLat: null, currentLng: null, locationAccuracy: null };
    for (const k of ['lat', 'lng', 'latitude', 'longitude']) if (isNum(d[k])) patch[k] = coarse(d[k]);
    if (typeof d.geohash === 'string' && d.geohash.length > 5) patch.geohash = d.geohash.slice(0, 5);
    return patch;
}

async function* pages(collectionName, pageSize) {
    let last = null;
    for (;;) {
        let q = db().collection(collectionName).orderBy(FieldPath.documentId()).limit(pageSize);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) return;
        yield snap.docs;
        last = snap.docs[snap.docs.length - 1].id;
        if (snap.docs.length < pageSize) return;
    }
}

async function migrateArtisanLocations(mode, pageSize, report) {
    for await (const docs of pages('artisans', pageSize)) {
        for (const doc of docs) {
            const d = doc.data();
            if (!exposesLocation(d)) continue;
            report.artisans.exposed++;
            const privRef = doc.ref.collection('private').doc('location');
            if (mode === 'dry-run') { report.artisans.ids.push(doc.id); continue; }
            await db().runTransaction(async (txn) => {
                const [live, priv] = await Promise.all([txn.get(doc.ref), txn.get(privRef)]);
                if (!live.exists) return;
                const cur = live.data();
                const pos = legacyPosition(cur);
                let held = priv.exists && isNum(priv.data().lat) && isNum(priv.data().lng);
                if (!held && pos) {
                    txn.set(privRef, {
                        lat: pos.lat, lng: pos.lng,
                        accuracy: isNum(cur.locationAccuracy) ? cur.locationAccuracy : null,
                        source: 'migrated', updatedAt: nowIso(),
                    });
                    held = true;
                    report.artisans.copied++;
                }
                if (mode === 'strip' && (held || !pos)) {
                    txn.update(doc.ref, { ...publicLocationPatch(cur), updatedAt: nowIso() });
                    report.artisans.stripped++;
                }
            });
            report.artisans.ids.push(doc.id);
        }
    }
}

async function migrateBookingContacts(mode, pageSize, report) {
    for await (const docs of pages('bookings', pageSize)) {
        for (const doc of docs) {
            const d = doc.data();
            if (d.customerPhone === undefined) continue;
            report.bookings.exposed++;
            const contactRef = doc.ref.collection('private').doc('contact');
            if (mode === 'dry-run') { report.bookings.ids.push(doc.id); continue; }
            await db().runTransaction(async (txn) => {
                const [live, contact] = await Promise.all([txn.get(doc.ref), txn.get(contactRef)]);
                if (!live.exists) return;
                const cur = live.data();
                if (cur.customerPhone === undefined) return;
                let held = contact.exists && contact.data().customerPhone !== undefined;
                if (!held) {
                    txn.set(contactRef, {
                        bookingId: doc.id, customerId: cur.customerId || null,
                        customerPhone: cur.customerPhone ?? null, updatedAt: nowIso(),
                    });
                    held = true;
                    report.bookings.copied++;
                }
                if (mode === 'strip' && held) {
                    txn.update(doc.ref, { customerPhone: FieldValue.delete() });
                    report.bookings.stripped++;
                }
            });
            report.bookings.ids.push(doc.id);
        }
    }
}

// CONTACT-001: copies of the ARTISAN's phone that clients wrote onto bookings
// (bookingService proPhone; book-emergency artisan.phone / professional.phone,
// the latter as a tel: link). Each booking reads like a public profile to its
// customer, outside the disclosure window, so they move to
// bookings/{id}/private/artisanContact — the record the accept trigger writes
// and firestore.rules disclose only while the job is live.
const BOOKING_ARTISAN_PHONE_PATHS = Object.freeze(['proPhone', 'artisanPhone', 'artisan.phone', 'professional.phone']);

function readPath(d, p) {
    return p.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), d);
}
function bookingArtisanPhones(d) {
    return BOOKING_ARTISAN_PHONE_PATHS.filter((p) => readPath(d, p) !== undefined);
}
const asPhone = (v) => (typeof v === 'string' || typeof v === 'number')
    ? String(v).trim().replace(/^tel:/i, '').trim() : '';

async function migrateBookingArtisanPhones(mode, pageSize, report) {
    for await (const docs of pages('bookings', pageSize)) {
        for (const doc of docs) {
            if (!bookingArtisanPhones(doc.data()).length) continue;
            report.artisanPhones.exposed++;
            const contactRef = doc.ref.collection('private').doc('artisanContact');
            if (mode === 'dry-run') { report.artisanPhones.ids.push(doc.id); continue; }
            await db().runTransaction(async (txn) => {
                const [live, contact] = await Promise.all([txn.get(doc.ref), txn.get(contactRef)]);
                if (!live.exists) return;
                const cur   = live.data();
                const found = bookingArtisanPhones(cur);
                if (!found.length) return;
                const phone = found.map((p) => asPhone(readPath(cur, p))).find((v) => v && v.length <= 32) || '';
                const held  = contact.exists && asPhone(contact.data().artisanPhone) !== '';
                // Never overwrites: the accept trigger's record reads the artisan's
                // own private/contact and is newer than any client copy.
                if (!held && phone && cur.artisanId) {
                    txn.set(contactRef, {
                        bookingId: doc.id, artisanId: cur.artisanId,
                        artisanPhone: phone, updatedAt: nowIso(),
                    });
                    report.artisanPhones.copied++;
                }
                // A copy with no home (no artisan on the booking, or no usable
                // number) is still stripped: the artisan's own private/contact
                // is the source of truth, and the booking copy is never needed.
                if (mode === 'strip') {
                    // A nested copy goes by rewriting its map without the phone:
                    // the transaction holds the version read above, so nothing
                    // else in the map can be lost.
                    const patch = {};
                    for (const p of found) {
                        const [top, sub] = p.split('.');
                        if (!sub) { patch[top] = FieldValue.delete(); continue; }
                        const { [sub]: _gone, ...rest } = patch[top] || cur[top];
                        patch[top] = rest;
                    }
                    txn.update(doc.ref, patch);
                    report.artisanPhones.stripped++;
                }
            });
            report.artisanPhones.ids.push(doc.id);
        }
    }
}

/**
 * @param {{ mode?: 'dry-run'|'copy'|'strip', pageSize?: number }} opts
 * @returns {Promise<object>} counts and document ids — no values
 */
async function migrateContactPrivacy({ mode = 'dry-run', pageSize = 200 } = {}) {
    if (!MODES.has(mode)) throw new Error(`Unknown mode "${mode}". Use dry-run, copy or strip.`);
    const size = Math.max(1, Math.min(500, Number(pageSize) || 200));
    const report = {
        mode,
        artisans: { exposed: 0, copied: 0, stripped: 0, ids: [] },
        bookings: { exposed: 0, copied: 0, stripped: 0, ids: [] },
        artisanPhones: { exposed: 0, copied: 0, stripped: 0, ids: [] },
    };
    await migrateArtisanLocations(mode, size, report);
    await migrateBookingContacts(mode, size, report);
    await migrateBookingArtisanPhones(mode, size, report);
    return report;
}

module.exports = { migrateContactPrivacy, exposesLocation, publicLocationPatch, legacyPosition, BOOKING_ARTISAN_PHONE_PATHS };
