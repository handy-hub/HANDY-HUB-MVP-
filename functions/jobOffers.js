'use strict';

/**
 * functions/jobOffers.js — what an artisan sees before they take a job, and the
 * one server path by which they take it.
 *
 * WHY THIS EXISTS (AR-06, 2026-10-20 artisan audit)
 * ─────────────────────────────────────────────────
 * Dispatch offered a booking by writing the candidate's uid into
 * booking.artisanId, and firestore.rules let whoever held artisanId read the
 * whole booking: the customer's exact address, GPS position, notes and phone.
 * Every artisan in the dispatch chain received all of it, and kept it after
 * declining. The customer-chosen emergency flow did the same from the moment
 * the booking was created. Hiding the Call button was the only protection.
 *
 * THE POLICY, BY BOOKING STATE
 *   offered (pending)   job_offers/{bookingId} only — service, description,
 *                       photos, approximate area and distance, appointment, pay,
 *                       the customer's first name, the deadline. NO exact
 *                       address, coordinates, notes or phone. Readable by the
 *                       offered artisan while the offer is open; closed the
 *                       moment it is accepted, declined, expires or is withdrawn.
 *   accepted onwards    the booking itself (address, coordinates, notes):
 *                       booking.artisanId is set ONLY here, on acceptance.
 *   committed + funded  bookings/{id}/private/contact (the customer's phone) —
 *                       see contactDisclosed() in firestore.rules: not before the
 *                       inspection callout is paid, not after the job ends.
 *   terminal            the artisan keeps the job record (it is their work
 *                       history); the phone closes.
 * Customers read their own booking and contact; admins read everything.
 */

const { FIRESTORE_DB_ID } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const nowIso = () => new Date().toISOString();
const coarse = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v) * 100) / 100 : null);

/**
 * Booking fields an artisan needs to DECIDE, copied verbatim (same names, so
 * the job cards render an offer exactly as they render a booking). Everything
 * not listed — address, exact lat/lng, notes, phone, customerId — stays on the
 * booking, which the artisan cannot read until they accept.
 */
const OFFER_FIELDS = Object.freeze([
    'serviceType', 'service', 'category', 'description', 'photos',
    'track', 'type', 'bookingType', 'isEmergency', 'priceType',
    'calloutFee', 'travelFee', 'travelEstimated', 'jobQuote',
    'scheduledFor', 'scheduledForMs', 'scheduleWindowMins', 'dateDisplay',
    'customerFirstName', 'createdAt',
]);

/** The summary an offered artisan may read. Pure — tests hold its shape. */
function buildOfferDoc(booking, { bookingId, artisanId, expiresAtMs = null, round = null, distanceKm = null, prematched = false }) {
    const b = booking || {};
    const doc = {};
    for (const k of OFFER_FIELDS) if (b[k] !== undefined) doc[k] = b[k];
    return {
        ...doc,
        bookingId,
        artisanId,
        offerStatus:  'open',
        // The job cards key off booking-shaped fields; an open offer IS a pending request.
        status:       'pending',
        prematched:   !!prematched,
        round,
        // Where, to the precision a decision needs: ~1.1 km, and the distance
        // computed server-side from the artisan's precise (private) position.
        lat:                 coarse(b.lat),
        lng:                 coarse(b.lng),
        locationApproximate: true,
        distanceKm:          Number.isFinite(distanceKm) ? Math.round(distanceKm * 10) / 10 : null,
        expiresAtMs:         Number.isFinite(expiresAtMs) ? expiresAtMs : null,
        offeredAt:           nowIso(),
    };
}

const offerRef = (bookingId) => db().collection('job_offers').doc(bookingId);

/** Close the booking's offer (in a transaction when one is given). Never throws for a missing offer. */
function closeOffer(txn, bookingId, outcome) {
    const patch = { offerStatus: outcome, closedAt: nowIso() };
    if (txn) { txn.set(offerRef(bookingId), patch, { merge: true }); return null; }
    return offerRef(bookingId).set(patch, { merge: true }).catch(() => {});
}

function offerError(reason, message) {
    const err = new Error(message);
    err.reason = reason;
    return err;
}

/**
 * respondToJobOffer — the ONLY way an offer is accepted or declined.
 *
 * Accept: the offer must be this artisan's, still open and not expired; the
 * booking still pending and still offered to them; the artisan approved and
 * active. Then, in one transaction, booking.artisanId is set (which is what
 * opens the booking to them), the booking moves to accepted, and the offer
 * closes. onBookingStatusChanged then runs the existing acceptance side effects
 * (escrow hold on the standard track, identity stamp, notifications).
 *
 * Decline: the booking moves to rejected, exactly as the client write used to,
 * so dispatch re-offers it (or, for a customer-chosen artisan, the customer is
 * told). Declining needs no approval — an artisan can always say no.
 */
async function respondToJobOffer(auth, { bookingId, decision } = {}) {
    if (!auth || !auth.uid) throw offerError('unauthenticated', 'Sign in to respond to job requests.');
    if (!bookingId || typeof bookingId !== 'string') throw offerError('invalid', 'bookingId is required.');
    if (decision !== 'accept' && decision !== 'decline') throw offerError('invalid', 'decision must be accept or decline.');
    const uid = auth.uid;

    const bookingRef = db().collection('bookings').doc(bookingId);
    const artisanRef = db().collection('artisans').doc(uid);

    return db().runTransaction(async (txn) => {
        const [offerSnap, bookingSnap, artisanSnap] = await Promise.all([
            txn.get(offerRef(bookingId)), txn.get(bookingRef), txn.get(artisanRef),
        ]);
        const offer = offerSnap.exists ? offerSnap.data() : null;
        if (!offer || offer.artisanId !== uid) {
            throw offerError('not_offered', 'This job request is not offered to you.');
        }
        if (offer.offerStatus !== 'open') {
            throw offerError('closed', offer.offerStatus === 'expired'
                ? 'This request has expired and has been offered to another professional.'
                : 'This request is no longer open.');
        }
        if (!bookingSnap.exists) throw offerError('closed', 'This request is no longer available.');
        const b = bookingSnap.data();
        if (String(b.status || '').toLowerCase() !== 'pending' ||
            (b.currentArtisanId && b.currentArtisanId !== uid)) {
            throw offerError('closed', 'This request is no longer open.');
        }
        if (Number.isFinite(offer.expiresAtMs) && Date.now() >= offer.expiresAtMs) {
            throw offerError('expired', 'This request has expired and has been offered to another professional.');
        }

        const n = nowIso();
        if (decision === 'decline') {
            txn.update(bookingRef, { status: 'rejected', rejectedAt: n, updatedAt: n });
            txn.set(offerRef(bookingId), { offerStatus: 'declined', closedAt: n }, { merge: true });
            return { status: 'rejected' };
        }

        const a = artisanSnap.exists ? artisanSnap.data() : null;
        if (!a || a.userType !== 'artisan' || a.status !== 'active' || a.verificationStatus !== 'approved') {
            throw offerError('not_eligible', 'Complete your verification before accepting jobs.');
        }
        txn.update(bookingRef, {
            status:     'accepted',
            artisanId:  uid,            // ← this is what opens the booking to the artisan
            acceptedAt: n,
            updatedAt:  n,
        });
        txn.set(offerRef(bookingId), { offerStatus: 'accepted', closedAt: n }, { merge: true });
        return { status: 'accepted' };
    });
}

/**
 * The customer's phone, kept off the booking document. Written server-side
 * (createInspectionBooking); read through firestore.rules' contactDisclosed().
 */
function contactRef(bookingId) {
    return db().collection('bookings').doc(bookingId).collection('private').doc('contact');
}

module.exports = {
    OFFER_FIELDS,
    buildOfferDoc,
    closeOffer,
    offerRef,
    contactRef,
    respondToJobOffer,
};
