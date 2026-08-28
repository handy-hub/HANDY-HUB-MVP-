/**
 * completeBooking.js — THE single client path for "the customer confirms the
 * work is done".
 *
 * There is exactly one thing the client may do at this moment: write the
 * booking's status transition. Everything financial that follows is the
 * server's, and it already works.
 *
 * WHY THIS MODULE EXISTS — do not "helpfully" add the escrow call back
 * ────────────────────────────────────────────────────────────────────
 * `onBookingStatusChanged` (functions/bookings.js) fires on this exact
 * transition and calls `_releaseEscrowForBooking()`, which finds the held
 * escrow and releases it through the same transactional path everything else
 * uses. A 6-hourly auto-release scheduler retries anything that fails.
 *
 * Both customer screens ALSO called `releaseEscrow()` directly from the client
 * on top of that. The money never doubled — `escrow.releaseEscrow()` re-reads
 * the escrow inside `runTransaction()` and refuses anything that is not still
 * `held`, so Firestore's optimistic lock let exactly one of the two win. But
 * the loser threw on every single completion, into a `.catch(console.warn)` on
 * both screens, and it burned a rate-limited payment callable to do it.
 *
 * That is a second settlement path for money that already has one, which this
 * project forbids for exactly this reason (CLAUDE.md §2). One path. This one.
 *
 * WHAT THE CALLER MUST NOT DO
 * ───────────────────────────
 * Do not navigate on a rejected promise, and do not paint "complete" before it
 * resolves. This write IS the payment instruction: if it fails and the screen
 * moves on anyway, the customer is looking at a receipt for a job the backend
 * never completed and the artisan is not paid until the auto-release window
 * elapses. live-tracking.html did precisely that — the write was launched
 * fire-and-forget and never awaited.
 */

/**
 * Confirm a job is complete. Resolves only once the transition is committed.
 *
 * @param {object}  args
 * @param {string}  args.bookingId       the booking being completed
 * @param {object}  args.databaseService the app container's database service
 * @returns {Promise<{ bookingId: string, completedAt: string }>}
 * @throws if the transition is rejected — the caller must stay put and say so
 */
export async function confirmBookingComplete({ bookingId, databaseService }) {
    if (!bookingId) {
        throw new Error('Cannot confirm completion without a booking id.');
    }
    if (!databaseService) {
        throw new Error('confirmBookingComplete requires the database service.');
    }

    const completedAt = new Date().toISOString();

    // Firestore rules allow exactly this shape from the customer:
    // awaiting → completed, keys limited to status/completedAt/updatedAt.
    await databaseService.updateDocument('bookings', bookingId, {
        status:      'completed',
        completedAt,
        updatedAt:   completedAt,
    });

    return { bookingId, completedAt };
}

/**
 * Where the customer goes after confirming. The receipt resolves the booking
 * from this id — never from a session hand-off, which a refresh destroys.
 */
export function receiptHref(bookingId) {
    return bookingId
        ? `review.html?bookingId=${encodeURIComponent(bookingId)}`
        : 'review.html';
}
