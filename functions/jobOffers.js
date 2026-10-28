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

// ── Offer events: the source of the response rate (AR-12) ────────────────────
// job_offers/{bookingId} is ONE document per booking, overwritten round by
// round, so it cannot say how an artisan answered past offers. Every close now
// also writes offer_events/{bookingId}_{round}_{artisanId} in the SAME
// transaction: the id is deterministic, so a retried or duplicated close
// rewrites the same record instead of counting twice, and only offers create
// events. shared/js/domain/performanceMetrics.js defines what they count for.
function offerEventRef(bookingId, offer) {
    const round = offer && offer.round != null ? offer.round : 'p';
    return db().collection('offer_events').doc(`${bookingId}_${round}_${offer.artisanId}`);
}
function offerEventDoc(bookingId, offer, outcome, closedAt) {
    const offeredMs = Date.parse(offer.offeredAt);
    const closedMs  = Date.parse(closedAt);
    return {
        bookingId,
        artisanId:   offer.artisanId,
        round:       offer.round ?? null,
        prematched:  !!offer.prematched,
        outcome,
        offeredAt:   offer.offeredAt || null,
        expiresAtMs: Number.isFinite(offer.expiresAtMs) ? offer.expiresAtMs : null,
        closedAt,
        responseMs:  ['accepted', 'declined'].includes(outcome) && Number.isFinite(offeredMs) && Number.isFinite(closedMs)
            ? Math.max(0, closedMs - offeredMs) : null,
    };
}

/**
 * Close the booking's offer and record how it ended. `offer` is the offer as
 * read in the same transaction; it is closed only while still open, so a late
 * "withdrawn" can never overwrite an accepted or expired outcome. Without a
 * transaction, one is run. Never throws for a missing offer.
 */
function closeOffer(txn, bookingId, outcome, offer = null) {
    if (txn) {
        const n = nowIso();
        txn.set(offerRef(bookingId), { offerStatus: outcome, closedAt: n }, { merge: true });
        if (offer && offer.artisanId && offer.offerStatus === 'open') {
            txn.set(offerEventRef(bookingId, offer), offerEventDoc(bookingId, offer, outcome, n));
        }
        return null;
    }
    return db().runTransaction(async (t) => {
        const snap = await t.get(offerRef(bookingId));
        if (!snap.exists || snap.data().offerStatus !== 'open') return false;
        closeOffer(t, bookingId, outcome, snap.data());
        return true;
    }).catch(() => false);
}

/**
 * Recompute an artisan's response figures from their offer events and store
 * them on the profile (server-only fields; syncArtisanIndex carries the rate to
 * dispatch). A full recompute, not an increment: it is idempotent, and a
 * failed refresh is repaired by the next one. Never throws.
 */
async function refreshResponseStats(artisanId) {
    if (!artisanId) return null;
    try {
        const { computeResponseStats, RESPONSE_RATE_POLICY } = require('./shared/performanceMetrics');
        const fromIso = new Date(Date.now() - RESPONSE_RATE_POLICY.windowDays * 86400000).toISOString();
        const snap = await db().collection('offer_events')
            .where('artisanId', '==', artisanId)
            .where('closedAt', '>=', fromIso)
            .get();
        const stats = computeResponseStats(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        const responseStats = { ...stats, computedAt: nowIso() };
        await db().collection('artisans').doc(artisanId).update({ responseStats, responseRate: stats.rate });
        return responseStats;
    } catch (err) {
        console.error(`[jobOffers] Response stats refresh failed artisan=${artisanId}:`, err.message);
        return null;
    }
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

    const result = await db().runTransaction(async (txn) => {
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
        // The server clock decides, never the client's. An offer written before
        // expiresAtMs existed falls back to the booking's responseDeadline, so a
        // legacy offer cannot skip the expiry check altogether.
        const rd = b.responseDeadline;
        const deadlineMs = Number.isFinite(offer.expiresAtMs) ? offer.expiresAtMs
            : (rd && typeof rd.toMillis === 'function') ? rd.toMillis()
            : (typeof rd === 'string' && Number.isFinite(Date.parse(rd))) ? Date.parse(rd)
            : null;
        if (deadlineMs !== null && Date.now() >= deadlineMs) {
            throw offerError('expired', 'This request has expired and has been offered to another professional.');
        }

        const n = nowIso();
        if (decision === 'decline') {
            txn.update(bookingRef, { status: 'rejected', rejectedAt: n, updatedAt: n });
            closeOffer(txn, bookingId, 'declined', offer);
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
        closeOffer(txn, bookingId, 'accepted', offer);
        return { status: 'accepted' };
    });
    await refreshResponseStats(uid);
    return result;
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
    offerEventRef,
    contactRef,
    respondToJobOffer,
    refreshResponseStats,
};
