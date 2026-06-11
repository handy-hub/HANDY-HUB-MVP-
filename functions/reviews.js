'use strict';

/**
 * functions/reviews.js — Review lifecycle Cloud Function
 *
 * onBookingReviewed
 * ─────────────────
 * Trigger: any bookings/{bookingId} document update
 * Condition: booking's `rating` field was null/absent before and is now a
 *            number — i.e. a customer has just submitted their first review.
 *
 * What it does:
 *   1. Reads the artisan document inside a Firestore transaction.
 *   2. Computes the new rolling average: ((old_avg * old_count) + score) / (old_count + 1).
 *   3. Atomically writes the new rating + reviewCount to the artisan document.
 *   4. Marks the booking with ratingProcessed: true so re-runs are no-ops.
 *
 * Idempotency
 * ───────────
 * The `ratingProcessed: true` flag is written within the same transaction as
 * the artisan update. Two concurrent invocations will both enter the
 * transaction; the second sees ratingProcessed=true and exits cleanly.
 * A re-fire after the write (triggered by ratingProcessed being set) exits
 * before the transaction because before.rating is no longer null.
 *
 * The legacy client-side artisanRepository.applyNewReview() is a deprecated
 * no-op — this Cloud Function is now the sole authority for artisan ratings.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { FUNCTIONS_REGION, FIRESTORE_DB_ID } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const onBookingReviewed = onDocumentUpdated(
    { document: 'bookings/{bookingId}', region: FUNCTIONS_REGION },
    async (event) => {
        const before    = event.data.before.data();
        const after     = event.data.after.data();
        const bookingId = event.params.bookingId;

        // Only fire when `rating` is first added to the booking document.
        // Re-reviews are blocked by Firestore rules; this guard handles replays.
        const ratingJustAdded =
            (before.rating == null) && (typeof after.rating === 'number');
        if (!ratingJustAdded) return;

        // Idempotency guard: already processed (shouldn't happen given the above,
        // but cheap insurance against unexpected re-fires).
        if (after.ratingProcessed === true) return;

        const artisanId = after.artisanId;
        const newScore  = Math.max(1, Math.min(5, Number(after.rating)));

        if (!artisanId) {
            console.warn(`[reviews] No artisanId on booking=${bookingId} — skipping rating update.`);
            return;
        }
        if (isNaN(newScore)) {
            console.error(`[reviews] Invalid rating "${after.rating}" on booking=${bookingId} — skipping.`);
            return;
        }

        const artisanRef = db().collection('artisans').doc(artisanId);
        const bookingRef = db().collection('bookings').doc(bookingId);

        try {
            await db().runTransaction(async (txn) => {
                const [artisanSnap, bookingSnap] = await Promise.all([
                    txn.get(artisanRef),
                    txn.get(bookingRef),
                ]);

                // Concurrent-invocation guard: second runner sees this and exits.
                if (bookingSnap.data()?.ratingProcessed === true) return;

                if (!artisanSnap.exists) {
                    console.error(`[reviews] Artisan document not found: artisanId=${artisanId}`);
                    return;
                }

                const { rating = 0, reviewCount = 0 } = artisanSnap.data();
                const nextCount  = reviewCount + 1;
                const rawAvg     = ((rating * reviewCount) + newScore) / nextCount;
                const nextRating = Math.round(rawAvg * 10) / 10;  // 1 decimal place

                txn.update(artisanRef, {
                    rating:      nextRating,
                    reviewCount: nextCount,
                    updatedAt:   new Date().toISOString(),
                });

                // Mark booking as processed so this transaction never runs twice.
                // Admin SDK write bypasses Firestore rules — no rule update needed.
                txn.update(bookingRef, {
                    ratingProcessed: true,
                });
            });

            console.log(`[reviews] Rating updated: artisan=${artisanId} booking=${bookingId} score=${newScore}`);

        } catch (err) {
            // Log but don't rethrow: Firebase retry logic will re-invoke on transient errors.
            // Permanent errors (artisan deleted, invalid data) are logged for manual review.
            console.error(`[reviews] Transaction failed: artisan=${artisanId} booking=${bookingId} — ${err.message}`);
        }
    }
);

module.exports = { onBookingReviewed };
