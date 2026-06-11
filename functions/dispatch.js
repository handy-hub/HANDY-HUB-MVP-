'use strict';

/**
 * functions/dispatch.js — Realtime booking dispatch engine
 *
 * Implements Uber/Bolt-style sequential artisan matching:
 *
 *   1. Booking created  → initialise dispatch fields → run dispatchRound()
 *   2. dispatchRound()  → find best eligible artisan → notify them → set deadline
 *   3. Artisan rejects  → log rejection → run dispatchRound() immediately
 *   4. Deadline expires → log timeout  → run dispatchRound() (scheduler every 1 min)
 *   5. No artisans left → mark unfulfilled → notify customer
 *   6. Artisan accepts  → Firestore rules handle it; bookings.js sends customer notif
 *
 * Timeout constants:
 *   Standard bookings: 3 hours
 *   Emergency bookings: 30 seconds
 *
 * Race-condition safety:
 *   dispatchRound() runs inside a Firestore transaction. Only one round can be
 *   active at a time (locked by dispatchStatus == 'dispatched'). Concurrent
 *   triggers that arrive before a round completes are silently dropped.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule }    = require('firebase-functions/v2/scheduler');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID, FUNCTIONS_REGION } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const { geohashQueryBounds } = require('geofire-common');

const STANDARD_TIMEOUT_S  = 3 * 60 * 60; // 3 hours
// 65 s > 60 s scheduler period — guarantees the per-minute scheduler
// always catches an expired emergency within one tick (no 90-second worst case).
const EMERGENCY_TIMEOUT_S = 65;

// ── Firestore singleton ───────────────────────────────────────────────────────
let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
    const R   = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a   = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Find and rank eligible artisans ──────────────────────────────────────────
//
// TWO-PHASE DISPATCH LOOKUP
//
// Phase 1 — artisan_index (cheap, small docs, ~400 bytes each):
//   Query artisan_index by geohash range. Returns only the fields needed for
//   candidate selection + dispatch notification. Never touches artisans collection.
//
// Phase 2 — artisans full profile (only for the chosen artisan):
//   Fetched by dispatchRound() after this function returns, when writing the
//   booking assignment. Not done here — dispatch notification data is already
//   in the index (name, profileImage, specialty, rating).
//
// Read budget per dispatch round:
//   artisan_index reads : ~45–90 (9 cells × ~5–10 results each)
//   artisans reads      : 0 (Phase 2 handled by caller for chosen artisan only)
//   Total               : < 100 — target met at any scale.
//
// Fallback: booking has no coordinates → capped index scan, max 200 docs.
// artisan_index is far smaller than artisans, so even the fallback is cheap.
async function findEligibleArtisans(booking, excludeIds) {
    const bookingLat  = booking.lat || booking.userLat || null;
    const bookingLng  = booking.lng || booking.userLng || null;
    const serviceType = (booking.serviceType || booking.service || '').toLowerCase();

    let candidates = [];

    if (bookingLat != null && bookingLng != null) {
        // ── Phase 1: artisan_index geohash proximity queries ─────────────────
        // 25 km cast net — wider than max workRadius (20 km) to catch edge artisans.
        // Exact distance enforced in the filter step below.
        const bounds = geohashQueryBounds([bookingLat, bookingLng], 25_000);

        const snaps = await Promise.all(
            bounds.map(([start, end]) =>
                db().collection('artisan_index')
                    .where('isAvailable',        '==', true)
                    .where('status',             '==', 'active')
                    .where('verificationStatus', '==', 'approved')
                    .where('geohash',            '>=', start)
                    .where('geohash',            '<=', end)
                    .limit(50)
                    .get()
            )
        );

        const seen = new Set();
        for (const snap of snaps) {
            for (const doc of snap.docs) {
                if (!seen.has(doc.id)) {
                    seen.add(doc.id);
                    candidates.push({ id: doc.id, ...doc.data() });
                }
            }
        }
    } else {
        // ── Fallback: no booking coordinates ─────────────────────────────────
        // artisan_index docs are ~400 bytes; 200-doc scan is ~80 KB, not dangerous.
        console.warn(`[dispatch] No booking coordinates — fallback index scan (booking=${booking.id || '?'})`);
        const snap = await db().collection('artisan_index')
            .where('isAvailable',        '==', true)
            .where('status',             '==', 'active')
            .where('verificationStatus', '==', 'approved')
            .limit(200)
            .get();
        candidates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    // ── Filter, rank, hard-limit ──────────────────────────────────────────────
    // HARD_LIMIT: never consider more than 20 candidates per round.
    // Dispatch is sequential (one artisan at a time). 20 rounds of rejection
    // before a booking is unfulfilled is already a generous ceiling.
    const HARD_LIMIT = 20;

    return candidates
        .filter(a => {
            if (excludeIds.includes(a.id)) return false;

            // Skill match: artisan_index.skills[] contains category synonyms.
            // First keyword of serviceType matched against the skills array.
            if (serviceType) {
                const keyword = serviceType.split(/[\s,/]+/)[0];
                if (keyword.length > 2 &&
                    !(a.skills || []).some(s => s.includes(keyword))) return false;
            }

            // Exact distance check — geohash cells are rectangular, not circular.
            if (bookingLat != null && bookingLng != null && a.lat && a.lng) {
                const dist = haversineKm(bookingLat, bookingLng, a.lat, a.lng);
                if (dist > (a.workRadius || 20)) return false;
                a._distKm = dist;
            }

            return true;
        })
        .map(a => {
            let score = 0;
            score += (a.rating         || 4.0) * 15;  // max 60
            score += (a.completionRate || 0.8) * 20;  // max 20
            score += (a.responseRate   || 0.7) * 15;  // max 15
            score += a.isOnline ? 20 : 0;              // online bonus
            if (a._distKm != null) score -= a._distKm * 1.5; // distance penalty
            a._score = score;
            return a;
        })
        .sort((a, b) => b._score - a._score)
        .slice(0, HARD_LIMIT);
}

// ── Core dispatch round (transaction-safe) ────────────────────────────────────
async function dispatchRound(bookingId) {
    const bookingRef = db().collection('bookings').doc(bookingId);
    let chosen, isEmergency, round, customerId, serviceType;

    const result = await db().runTransaction(async (txn) => {
        const snap    = await txn.get(bookingRef);
        if (!snap.exists) return { skipped: 'not_found' };

        const booking = snap.data();
        const status  = (booking.status || '').toLowerCase();

        // Guard: only dispatch if pending (not accepted/cancelled/completed)
        if (!['pending', 'searching'].includes(status) && booking.dispatchStatus !== 'searching') {
            return { skipped: `status_${status}` };
        }
        // Guard: prevent double-dispatch while a round is in flight
        if (booking.dispatchStatus === 'dispatched') {
            return { skipped: 'already_dispatched' };
        }

        isEmergency  = booking.bookingType === 'emergency' || booking.type === 'emergency';
        customerId   = booking.customerId;
        serviceType  = booking.serviceType || booking.service || 'Service';
        const timeout = isEmergency ? EMERGENCY_TIMEOUT_S : STANDARD_TIMEOUT_S;

        const alreadyTried = booking.artisanCandidates || [];
        round = (booking.currentDispatchRound || 0) + 1;

        // Find candidates — done outside transaction to avoid contention,
        // but we re-check eligibility inside via the excludeIds guard.
        const candidates = await findEligibleArtisans(booking, alreadyTried);

        if (candidates.length === 0) {
            txn.update(bookingRef, {
                status:               'unfulfilled',
                dispatchStatus:       'unfulfilled',
                currentDispatchRound: round,
                currentArtisanId:     null,
                updatedAt:            new Date().toISOString(),
            });
            return { unfulfilled: true };
        }

        chosen = candidates[0];
        const deadline = Timestamp.fromMillis(Date.now() + timeout * 1000);

        txn.update(bookingRef, {
            dispatchStatus:         'dispatched',
            // artisanId is set to the chosen artisan so the artisan dashboard query
            // (artisanId == auth.uid AND status == 'pending') surfaces this booking.
            artisanId:              chosen.id,
            currentArtisanId:       chosen.id,
            currentArtisanName:     chosen.name           || 'Professional',
            currentArtisanPhoto:    chosen.profileImage   || null,
            currentArtisanRating:   chosen.rating         || null,
            currentArtisanCategory: chosen.specialty      || chosen.category || null,
            responseDeadline:       deadline,
            currentDispatchRound:   round,
            lastDispatchAt:         new Date().toISOString(),
            artisanCandidates:      FieldValue.arrayUnion(chosen.id),
            updatedAt:              new Date().toISOString(),
        });

        return { dispatched: true };
    });

    // Post-transaction: send notification (outside txn to keep txn small)
    if (result.dispatched && chosen) {
        const distText   = chosen._distKm != null ? ` · ${chosen._distKm.toFixed(1)} km` : '';
        const timeoutTxt = isEmergency ? 'about 1 minute' : '3 hours';

        await sendArtisanNotification(chosen.id, {
            type:      'Bookings',
            title:     isEmergency ? '🚨 Emergency Job Request' : '📋 New Booking Request',
            message:   `${serviceType} request${distText}. You have ${timeoutTxt} to respond.`,
            actionUrl: 'dashboard.html',
            metadata:  {
                bookingId,
                serviceType,
                isEmergency,
                round,
            },
        }).catch(e => console.warn('[dispatch] artisan notif error:', e.message));

        console.log(`[dispatch] Round ${round}: booking ${bookingId} → artisan ${chosen.id}`);

    } else if (result.unfulfilled) {
        await sendNotification(customerId, {
            type:      'Bookings',
            title:     'No Professionals Available',
            message:   `We couldn't find an available professional for your ${serviceType} request. Please try again later.`,
            actionUrl: 'booking.html',
            metadata:  { bookingId },
        }).catch(e => console.warn('[dispatch] unfulfilled notif error:', e.message));

        console.log(`[dispatch] Booking ${bookingId} marked unfulfilled after ${round} round(s).`);
    } else {
        console.log(`[dispatch] Booking ${bookingId} skipped: ${JSON.stringify(result)}`);
    }

    return result;
}

// ── Trigger: booking CREATED → initialise + first dispatch ───────────────────
const onBookingCreated = onDocumentCreated(
    { document: 'bookings/{bookingId}', region: FUNCTIONS_REGION },
    async (event) => {
        const bookingId = event.params.bookingId;
        const data      = event.data.data();

        if ((data.status || '').toLowerCase() !== 'pending') return;

        // Standard bookings (type:'standard') and pre-matched emergency bookings
        // (artisanId already set by the customer choosing an artisan or the emergency
        // page doing a frontend query) are NOT re-dispatched here. The artisan was
        // already chosen; bookingConfirmNotify.js sent their notification. Dispatch
        // would reassign them and send a duplicate/conflicting notification.
        if (data.artisanId) {
            console.log(`[dispatch] Booking ${bookingId} already has artisanId=${data.artisanId} — skipping dispatch (pre-matched).`);
            return;
        }

        try {
            // Initialise dispatch metadata (before first round)
            await db().collection('bookings').doc(bookingId).update({
                dispatchStatus:       'searching',
                currentDispatchRound: 0,
                artisanCandidates:    [],
                dispatchHistory:      [],
                searchStartedAt:      new Date().toISOString(),
                updatedAt:            new Date().toISOString(),
            });

            await dispatchRound(bookingId);
        } catch (err) {
            console.error(`[dispatch] onBookingCreated error (${bookingId}):`, err.message);
        }
    }
);

// ── Dispatch event handler (called from bookings.js onBookingStatusChanged) ───
//
// Merged here from a separate onDocumentUpdated trigger to eliminate double
// Cloud Function invocations per booking write. bookings.js owns the single
// trigger; this function handles the dispatch-specific side effects.
async function handleDispatchEvent(before, after, bookingId) {
    const prevStatus = (before.status || '').toLowerCase();
    const nextStatus = (after.status  || '').toLowerCase();

    // ── Artisan rejected ──────────────────────────────────────────────────
    if (prevStatus === 'pending' && nextStatus === 'rejected') {
        const wasDispatched = before.dispatchStatus === 'dispatched';

        if (wasDispatched) {
            try {
                await db().collection('bookings').doc(bookingId).update({
                    status:           'pending',   // reset — customer never sees "rejected"
                    dispatchStatus:   'searching',
                    artisanId:        null,
                    currentArtisanId: null,
                    responseDeadline: null,
                    dispatchHistory:  FieldValue.arrayUnion({
                        artisanId:   after.artisanId || before.currentArtisanId || null,
                        response:    'rejected',
                        respondedAt: new Date().toISOString(),
                        round:       after.currentDispatchRound || 1,
                    }),
                    updatedAt: new Date().toISOString(),
                });

                if (after.customerId) {
                    await sendNotification(after.customerId, {
                        type:      'Bookings',
                        title:     'Searching for another professional…',
                        message:   'The previous professional couldn\'t take your booking. We\'re finding another one.',
                        actionUrl: 'book-step4.html',
                        metadata:  { bookingId },
                    }).catch(e => console.warn('[dispatch] searching notif error:', e.message));
                }

                await dispatchRound(bookingId);
            } catch (err) {
                console.error(`[dispatch] re-dispatch after rejection error (${bookingId}):`, err.message);
            }
        } else {
            console.log(`[dispatch] Booking ${bookingId} rejected (pre-matched, no re-dispatch).`);
        }
    }

    // ── Artisan accepted → clear dispatch timer ───────────────────────────
    if (prevStatus === 'pending' && nextStatus === 'accepted') {
        try {
            await db().collection('bookings').doc(bookingId).update({
                dispatchStatus:   'accepted',
                responseDeadline: null,
                dispatchHistory:  FieldValue.arrayUnion({
                    artisanId:   after.artisanId || null,
                    response:    'accepted',
                    respondedAt: new Date().toISOString(),
                    round:       after.currentDispatchRound || 1,
                }),
                updatedAt: new Date().toISOString(),
            });
        } catch (err) {
            console.error(`[dispatch] accept cleanup error (${bookingId}):`, err.message);
        }
    }
}

// ── Scheduler: expire timed-out dispatches → re-dispatch ─────────────────────
// Runs every minute. Finds bookings where responseDeadline has passed.
const checkExpiredDispatches = onSchedule(
    { schedule: 'every 1 minutes', region: FUNCTIONS_REGION },
    async () => {
        const now  = Timestamp.now();

        const snap = await db().collection('bookings')
            .where('dispatchStatus',   '==', 'dispatched')
            .where('responseDeadline', '<=', now)
            .get();

        if (snap.empty) return;
        console.log(`[dispatch] Expiring ${snap.size} timed-out dispatch(es)`);

        await Promise.all(snap.docs.map(async (doc) => {
            const bookingId = doc.id;
            const booking   = doc.data();
            try {
                // Log timeout
                await db().collection('bookings').doc(bookingId).update({
                    dispatchStatus:   'searching',
                    artisanId:        null,        // cleared so artisan dashboard doesn't show stale
                    currentArtisanId: null,
                    responseDeadline: null,
                    dispatchHistory:  FieldValue.arrayUnion({
                        artisanId:  booking.currentArtisanId || null,
                        response:   'timeout',
                        expiredAt:  new Date().toISOString(),
                        round:      booking.currentDispatchRound || 1,
                    }),
                    updatedAt: new Date().toISOString(),
                });

                // Notify customer
                if (booking.customerId) {
                    await sendNotification(booking.customerId, {
                        type:      'Bookings',
                        title:     'Searching for another professional…',
                        message:   'The previous professional didn\'t respond in time. Finding another one for you.',
                        actionUrl: 'book-step4.html',
                        metadata:  { bookingId },
                    }).catch(e => console.warn('[dispatch] timeout notif error:', e.message));
                }

                await dispatchRound(bookingId);
            } catch (err) {
                console.error(`[dispatch] expire error (${bookingId}):`, err.message);
            }
        }));
    }
);

module.exports = {
    onBookingCreated,
    checkExpiredDispatches,
    handleDispatchEvent,
    dispatchRound,
};
