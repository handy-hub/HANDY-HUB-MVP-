'use strict';

/**
 * functions/reviewAdmin.js — the correction path for a review that must be removed.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `rating` and `ratingProcessed` are server-only, and onBookingReviewed's
 * idempotency guard refuses to re-aggregate. Together those are correct — they
 * stop a customer rewriting their score while the public average keeps the first
 * one — but they left NO way to remove a review after it is written. A real
 * customer disputing a real review, a defamatory comment, or a review left on
 * the wrong booking had no remedy short of hand-editing production.
 *
 * That gap is what made the previous session's cleanup a manual console job.
 * This callable is the supported path.
 *
 * INVARIANTS
 * ──────────
 *  • Admin only. Reversing a review changes a professional's public
 *    standing and their livelihood; it is not a customer-facing action.
 *  • The aggregate is RECOMPUTED from the surviving reviews, never decremented
 *    arithmetically. Subtracting a score from a rounded average drifts, and the
 *    drift is permanent and invisible.
 *  • Every reversal is recorded in `review_reversals` with who, when and why.
 *    An unaudited ability to delete reputation is worse than no ability.
 *  • The booking returns to legitimately reviewable (fields deleted, not zeroed)
 *    so the customer may submit a corrected review through the normal path.
 */

const { FieldValue } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID, ADMIN_EMAILS } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

/**
 * Same guard the artisan-verification callables use (functions/artisanVerification.js):
 * an allow-listed email OR an admins/{uid} document. Reusing it rather than
 * inventing a second admin definition — two competing notions of "admin" is how
 * one of them ends up quietly weaker than the other.
 */
async function requireAdmin(auth) {
    if (!auth) throw new Error('Authentication required.');
    if (ADMIN_EMAILS.includes(auth.token?.email)) return true;
    const snap = await db().collection('admins').doc(auth.uid).get().catch(() => null);
    if (!snap?.exists) throw new Error('Unauthorized: Admin access only.');
    return true;
}

/**
 * Recompute an artisan's rating from the reviews that actually survive.
 *
 * Deliberately a full recount rather than `(avg*n - score)/(n-1)`: the stored
 * average is rounded to 1dp on every write, so reversing arithmetically
 * compounds rounding error into the artisan's public score with no way to detect
 * it later. Reading the reviews back is the only self-correcting option, and it
 * also repairs any pre-existing drift the moment a reversal happens.
 */
async function recomputeArtisanRating(artisanId) {
    const snap = await db().collection('bookings')
        .where('artisanId', '==', artisanId)
        .get();

    let sum = 0, count = 0;
    snap.docs.forEach(d => {
        const r = Number(d.data().rating);
        if (Number.isFinite(r) && r >= 1 && r <= 5) { sum += r; count += 1; }
    });

    // reviewCount 0 with rating 0 is the canonical unrated state; resolveRating()
    // renders it as "No reviews yet" and never as a zero-star score.
    const rating = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
    return { rating, reviewCount: count };
}

/**
 * Reverse one review and recompute the artisan's aggregate.
 * Payload: { bookingId, reason }
 */
async function reverseReview(auth, { bookingId, reason = '' }) {
    await requireAdmin(auth);
    if (!bookingId) throw new Error('bookingId is required.');
    const why = String(reason || '').trim().slice(0, 500);
    if (!why) throw new Error('A reason is required — reversals are audited.');

    const bookingRef = db().collection('bookings').doc(bookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) throw new Error('Booking not found.');

    const b = snap.data();
    if (b.rating == null) throw new Error('This booking carries no review to reverse.');

    const artisanId = b.artisanId;
    if (!artisanId) throw new Error('Booking has no artisan — nothing to recompute.');

    const removed = {
        rating:     Number(b.rating),
        review:     b.review ?? null,
        reviewedAt: b.reviewedAt ?? null,
    };

    // Clear the review first so the recount below cannot include it, then
    // recompute from what survives. Ordering matters: recomputing first would
    // race a concurrent reversal and re-add the score being removed.
    await bookingRef.update({
        rating:          FieldValue.delete(),
        review:          FieldValue.delete(),
        reviewedAt:      FieldValue.delete(),
        ratingProcessed: FieldValue.delete(),
        reviewReversedAt: new Date().toISOString(),
        updatedAt:       new Date().toISOString(),
    });

    const agg = await recomputeArtisanRating(artisanId);
    await db().collection('artisans').doc(artisanId).update({
        rating:      agg.rating,
        reviewCount: agg.reviewCount,
        updatedAt:   new Date().toISOString(),
    });

    await db().collection('review_reversals').add({
        bookingId,
        artisanId,
        customerId:   b.customerId || null,
        removed,
        recomputed:   agg,
        reason:       why,
        reversedBy:   auth?.token?.email || auth?.uid || 'unknown',
        reversedAt:   new Date().toISOString(),
    });

    console.log(`[reviewAdmin] Review reversed booking=${bookingId} artisan=${artisanId} ` +
                `removed=${removed.rating} → rating=${agg.rating} count=${agg.reviewCount}`);

    return { success: true, bookingId, artisanId, removed, recomputed: agg };
}

/**
 * Repair an artisan's aggregate from their reviews without removing anything.
 * For drift caused by historical direct writes.
 */
async function recomputeArtisanAggregate(auth, { artisanId }) {
    await requireAdmin(auth);
    if (!artisanId) throw new Error('artisanId is required.');

    const agg = await recomputeArtisanRating(artisanId);
    await db().collection('artisans').doc(artisanId).update({
        rating:      agg.rating,
        reviewCount: agg.reviewCount,
        updatedAt:   new Date().toISOString(),
    });
    console.log(`[reviewAdmin] Aggregate recomputed artisan=${artisanId} → ${JSON.stringify(agg)}`);
    return { success: true, artisanId, ...agg };
}

module.exports = { reverseReview, recomputeArtisanAggregate, recomputeArtisanRating };
