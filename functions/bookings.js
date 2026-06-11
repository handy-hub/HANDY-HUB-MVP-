'use strict';

/**
 * functions/bookings.js — Booking lifecycle Cloud Function triggers
 *
 * Triggers:
 *   onBookingStatusChanged — fires on every booking document update.
 *
 * ─── SERVER-AUTHORITATIVE ESCROW STATE MACHINE ───────────────────────────────
 * Escrow operations are driven exclusively by server-side status transitions.
 * Client-side calls to holdBookingFunds() / releaseEscrow() are deprecated —
 * they are idempotent no-ops protected by the _escrow_locks mechanism, but
 * should be removed from client code.
 *
 *   pending  → accepted  : holdFundsForBooking()  — funds locked; "accepted" notification sent
 *                           ONLY after hold succeeds. On failure → auto-cancelled; both notified.
 *   *        → cancelled : refundEscrow()          — held funds returned to customer immediately
 *   *        → completed : releaseEscrow()         — held funds paid to artisan wallet
 *
 * Zero-amount bookings (price == 0) skip escrow and proceed normally.
 *
 * ─── NOTIFICATION RULES ──────────────────────────────────────────────────────
 * pending  → accepted   : customer notified AFTER escrow hold succeeds
 * pending  → rejected   : customer notified IF booking was pre-matched (not dispatch-controlled)
 * accepted → en_route   : customer notified
 * en_route → in_progress: customer notified
 * in_progress → awaiting: customer notified
 * * → completed         : both notified; artisan jobsCompleted atomically incremented
 * * → cancelled         : both notified (suppressed for system_escrow_failure cancellations)
 * * → disputed          : both notified
 *
 * IMPORTANT: Requires a Firestore composite index on the escrow collection:
 *   Fields: bookingId (ASC), status (ASC)
 *   Used by: _findHeldEscrow() — called on every cancellation and completion
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { FieldValue }        = require('firebase-admin/firestore');
const { FUNCTIONS_REGION, FIRESTORE_DB_ID } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const escrow    = require('./financial/escrow');
const dispatch  = require('./dispatch');

// Lazy Firestore singleton (Admin SDK)
let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

// ── Status transition notification rules ──────────────────────────────────────
const TRANSITIONS = [
    // deferUntilEscrowHeld: this notification is sent by the escrow path (below),
    // not the generic loop — customer is notified "accepted" only after funds are secured.
    {
        from: 'pending',
        to:   'accepted',
        notify: 'customer',
        title:  '✅ Booking Accepted!',
        body:   (b) => `${b.artisanName || 'Your artisan'} has accepted your ${b.serviceType || 'service'} request. Your payment has been secured.`,
        type:   'booking_accepted',
        deferUntilEscrowHeld: true,
    },
    // Dispatch-controlled rejections are handled by dispatch.js (reset to 'pending').
    // This rule fires only for pre-matched bookings where dispatch never ran.
    {
        from: 'pending',
        to:   'rejected',
        notify: 'customer',
        title:  'Professional Unavailable',
        body:   (b) => `The ${b.serviceType || 'service'} professional was unable to accept your booking. Please try booking again.`,
        type:   'booking_rejected',
        onlyIfNotDispatched: true,
    },
    {
        from: 'accepted',
        to:   'en_route',
        notify: 'customer',
        title:  '🚗 Professional En Route',
        body:   (b) => `${b.artisanName || 'Your artisan'} is on the way to your location for your ${b.serviceType || 'service'} request.`,
        type:   'booking_en_route',
    },
    {
        from: 'en_route',
        to:   'in_progress',
        notify: 'customer',
        title:  '🔧 Job Started',
        body:   (b) => `${b.artisanName || 'Your artisan'} has arrived and started working on your ${b.serviceType || 'service'} request.`,
        type:   'booking_started',
    },
    {
        from: 'in_progress',
        to:   'awaiting',
        notify: 'customer',
        title:  '✅ Job Complete — Confirm?',
        body:   (b) => `${b.artisanName || 'Your artisan'} has marked the ${b.serviceType || 'service'} job as done. Please confirm to release payment.`,
        type:   'booking_awaiting',
    },
    {
        from: null,
        to:   'completed',
        notify: 'both',
        title:        '🎉 Job Completed!',
        body:         (b) => `Your ${b.serviceType || 'service'} booking has been marked complete. Payment has been released to the professional.`,
        artisanTitle: '💰 Job Completed',
        artisanBody:  (b) => `You completed a ${b.serviceType || 'service'} job. Your earnings have been credited to your wallet.`,
        type: 'booking_completed',
    },
    {
        from: null,
        to:   'cancelled',
        notify: 'both',
        title:        'Booking Cancelled',
        body:         (b) => `Your ${b.serviceType || 'service'} booking has been cancelled.`,
        artisanTitle: 'Booking Cancelled',
        artisanBody:  (b) => `A ${b.serviceType || 'service'} booking has been cancelled.`,
        type: 'booking_cancelled',
        // Suppressed when cancelledBy === 'system_escrow_failure' — both parties were
        // already notified with specific payment failure context by _handleEscrowHoldFailure.
        skipIfSystemCancelled: true,
    },
    {
        from: null,
        to:   'disputed',
        notify: 'both',
        title:        '⚠️ Dispute Raised',
        body:         (b) => `A dispute has been raised on your ${b.serviceType || 'service'} booking. Our team will review and contact you shortly.`,
        artisanTitle: '⚠️ Dispute Raised',
        artisanBody:  (b) => `A dispute has been raised on your ${b.serviceType || 'service'} booking. Funds are frozen pending admin review.`,
        type: 'booking_disputed',
    },
];

function _str(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }

// ── Escrow helpers ────────────────────────────────────────────────────────────

// Find the single 'held' escrow document for a booking.
// Requires composite Firestore index: escrow → bookingId ASC, status ASC.
async function _findHeldEscrow(bookingId) {
    const snap = await db()
        .collection('escrow')
        .where('bookingId', '==', bookingId)
        .where('status',    '==', 'held')
        .limit(1)
        .get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// Attempt to hold funds for an accepted booking.
// Returns { success: true } or { success: false, reason: string }.
async function _holdEscrowForAcceptance(bookingId, bookingData) {
    const customerId = bookingData.customerId || bookingData.userId || null;
    const artisanId  = bookingData.artisanId  || null;
    const amount     = Number(bookingData.price || bookingData.total || 0);

    if (!customerId) {
        console.error(`[bookings] Escrow hold skipped — no customerId: booking=${bookingId}`);
        return { success: true }; // no financial party; allow proceed
    }

    if (amount <= 0) {
        console.log(`[bookings] Zero-amount booking=${bookingId} — escrow skipped (cash/external payment).`);
        return { success: true };
    }

    try {
        const result = await escrow.holdFundsForBooking({
            bookingId,
            customerId,
            artisanId:  artisanId || null,
            amount,
            // null = system call from Admin SDK context; escrow.js treats this as server-authoritative.
            callerAuth: null,
        });

        const tag = result.idempotent ? '[IDEMPOTENT]' : '[NEW]';
        console.log(`[bookings] ${tag} Escrow held: booking=${bookingId} escrow=${result.escrowId} amount=GHS ${amount}`);
        return { success: true };

    } catch (holdErr) {
        console.error(`[bookings] Escrow hold FAILED: booking=${bookingId} reason="${holdErr.message}"`);
        return { success: false, reason: holdErr.message };
    }
}

// Release held escrow on job completion.
// Non-fatal: the 6-hour auto-release scheduler handles stuck escrows.
async function _releaseEscrowForBooking(bookingId) {
    try {
        const heldEscrow = await _findHeldEscrow(bookingId);
        if (!heldEscrow) {
            console.log(`[bookings] No held escrow for completed booking=${bookingId} — skipping release (zero-value or already released).`);
            return;
        }
        await escrow.releaseEscrow(heldEscrow.id, {
            releasedBy: 'booking_completion_trigger',
            callerAuth: null,
        });
        console.log(`[bookings] Escrow released: booking=${bookingId} escrow=${heldEscrow.id}`);
    } catch (releaseErr) {
        // Non-fatal. Auto-release scheduler (every 6h) will retry within ESCROW_AUTO_RELEASE_DAYS.
        console.error(`[bookings] Escrow release FAILED: booking=${bookingId} reason="${releaseErr.message}". Auto-release scheduler will retry.`);
    }
}

// Refund held escrow on any cancellation.
// Non-fatal: auto-release scheduler refunds stuck escrows within 7 days.
async function _refundEscrowForBooking(bookingId, bookingData) {
    try {
        const heldEscrow = await _findHeldEscrow(bookingId);
        if (!heldEscrow) {
            // Normal for pre-acceptance cancellations — no escrow was ever held.
            console.log(`[bookings] No held escrow for cancelled booking=${bookingId} — nothing to refund.`);
            return;
        }
        const reason = bookingData.cancellationReason || 'Booking cancelled';
        await escrow.refundEscrow(heldEscrow.id, {
            reason,
            refundedBy: 'booking_cancellation_trigger',
            callerAuth: null,
        });
        console.log(`[bookings] Escrow refunded: booking=${bookingId} escrow=${heldEscrow.id}`);
    } catch (refundErr) {
        console.error(`[bookings] Escrow refund FAILED: booking=${bookingId} reason="${refundErr.message}". Auto-release scheduler will refund within 7 days.`);
    }
}

// Cancel a booking after escrow hold failure and notify both parties with specific context.
// Triggers a second onBookingStatusChanged invocation (accepted → cancelled).
// skipIfSystemCancelled on the 'cancelled' TRANSITIONS rule suppresses duplicate
// generic cancellation notifications in that second invocation.
async function _handleEscrowHoldFailure(bookingId, bookingData, reason) {
    const customerId  = bookingData.customerId || bookingData.userId || null;
    const artisanId   = bookingData.artisanId  || null;
    const serviceType = bookingData.serviceType || bookingData.service || 'service';

    if (customerId) {
        await sendNotification(customerId, {
            type:      'Payments',
            title:     '⚠️ Payment Failed — Booking Cancelled',
            message:   `Your ${serviceType} booking was accepted but payment could not be secured: ${reason}. Please top up your wallet and rebook.`,
            actionUrl: 'topup.html',
            metadata:  { bookingId },
        }).catch(err => console.error('[bookings] escrow-fail notif error:', err?.message));
    }

    if (artisanId) {
        await sendArtisanNotification(artisanId, {
            type:      'Bookings',
            title:     'Booking Cancelled',
            message:   `A ${serviceType} booking was cancelled because the customer's payment could not be processed.`,
            actionUrl: 'dashboard.html',
            metadata:  { bookingId },
        }).catch(err => console.error('[bookings] artisan escrow-fail notif error:', err?.message));
    }

    try {
        await db().collection('bookings').doc(bookingId).update({
            status:             'cancelled',
            cancellationReason: `Auto-cancelled: ${reason}`,
            cancelledBy:        'system_escrow_failure',
            updatedAt:          new Date().toISOString(),
        });
        console.log(`[bookings] Booking ${bookingId} auto-cancelled (escrow failure: ${reason}).`);
    } catch (cancelErr) {
        console.error(`[bookings] Could not auto-cancel booking ${bookingId}: ${cancelErr.message}`);
    }
}

// ── Main trigger ───────────────────────────────────────────────────────────────

const onBookingStatusChanged = onDocumentUpdated(
    { document: 'bookings/{bookingId}', region: FUNCTIONS_REGION },
    async (event) => {
        const before    = event.data.before.data();
        const after     = event.data.after.data();
        const bookingId = event.params.bookingId;

        const prevStatus = _str(before.status);
        const nextStatus = _str(after.status);

        if (prevStatus === nextStatus) return; // metadata-only update, no status change

        const rule = TRANSITIONS.find(t =>
            (t.from === null || _str(t.from) === prevStatus) &&
            _str(t.to) === nextStatus
        );

        if (!rule) {
            console.log(`[bookings] No notification rule for ${prevStatus}→${nextStatus} booking=${bookingId}`);
        }

        const customerId        = after.customerId || after.userId || null;
        const artisanId         = after.artisanId  || null;
        const isSystemCancelled = after.cancelledBy === 'system_escrow_failure';

        const ctx = {
            bookingId,
            serviceType:  after.serviceType  || after.service || 'Service',
            artisanName:  after.artisanName  || after.proName || null,
            customerName: after.customerName || null,
        };

        // ── Immediate notifications ─────────────────────────────────────────
        // The 'pending → accepted' rule has deferUntilEscrowHeld: true.
        // Its notification is sent conditionally after escrow succeeds (see below).
        // All other transitions are notified immediately.
        const promises = [];

        if (rule && !rule.deferUntilEscrowHeld) {
            const shouldSkip =
                // Dispatch-controlled rejections: dispatch.js handles these itself
                (rule.onlyIfNotDispatched &&
                    (before.dispatchStatus === 'dispatched' ||
                     before.dispatchStatus === 'searching')) ||
                // System-cancelled bookings: payment-failure notifications already sent
                (rule.skipIfSystemCancelled && isSystemCancelled);

            if (!shouldSkip) {
                if ((rule.notify === 'customer' || rule.notify === 'both') && customerId) {
                    promises.push(
                        sendNotification(customerId, {
                            title:     rule.title,
                            body:      typeof rule.body === 'function' ? rule.body(ctx) : rule.body,
                            type:      rule.type,
                            bookingId,
                        }).catch(err => console.error('[bookings] customer notif error:', err?.message))
                    );
                }

                if ((rule.notify === 'artisan' || rule.notify === 'both') && artisanId) {
                    promises.push(
                        sendArtisanNotification(artisanId, {
                            title: rule.artisanTitle || rule.title,
                            body:  typeof (rule.artisanBody || rule.body) === 'function'
                                       ? (rule.artisanBody || rule.body)(ctx)
                                       : (rule.artisanBody || rule.body),
                            type:      rule.type,
                            bookingId,
                        }).catch(err => console.error('[bookings] artisan notif error:', err?.message))
                    );
                }
            }
        }

        // Atomically increment artisan jobsCompleted on completion (TOCTOU-safe).
        if (nextStatus === 'completed' && artisanId) {
            promises.push(
                db().collection('artisans').doc(artisanId).update({
                    jobsCompleted: FieldValue.increment(1),
                    updatedAt:     new Date().toISOString(),
                }).catch(err => console.error('[bookings] jobsCompleted increment error:', err?.message))
            );
        }

        await Promise.all(promises);

        // ── SERVER-AUTHORITATIVE ESCROW OPERATIONS ────────────────────────────
        //
        // Run AFTER initial notifications so artisan "new job" alerts are delivered
        // before payment processing begins.

        // 1. HOLD — pending → accepted
        //    Lock customer wallet funds in escrow.
        //    "Booking Accepted" customer notification sent ONLY after hold succeeds.
        //    On failure: auto-cancel booking, notify both parties with payment context.
        if (prevStatus === 'pending' && nextStatus === 'accepted') {
            const holdResult = await _holdEscrowForAcceptance(bookingId, after);

            if (holdResult.success) {
                if (rule && customerId) {
                    await sendNotification(customerId, {
                        title:     rule.title,
                        body:      typeof rule.body === 'function' ? rule.body(ctx) : rule.body,
                        type:      rule.type,
                        bookingId,
                    }).catch(err => console.error('[bookings] accepted notif error:', err?.message));
                }
            } else {
                await _handleEscrowHoldFailure(
                    bookingId,
                    after,
                    holdResult.reason || 'Payment could not be processed'
                );
            }
        }

        // 2. RELEASE — * → completed
        //    Transfer held escrow to artisan wallet (minus platform commission).
        //    Non-fatal: auto-release scheduler handles stuck escrows every 6 hours.
        if (nextStatus === 'completed') {
            await _releaseEscrowForBooking(bookingId);
        }

        // 3. REFUND — * → cancelled
        //    Return held escrow to customer immediately on any cancellation.
        //    Non-fatal: auto-release scheduler refunds stuck escrows within 7 days.
        if (nextStatus === 'cancelled') {
            await _refundEscrowForBooking(bookingId, after);
        }

        // ── Completion logging ─────────────────────────────────────────────────
        if (rule) {
            console.log(`[bookings] Dispatched: ${prevStatus}→${nextStatus} booking=${bookingId}`);
        }
        if (nextStatus === 'completed' && artisanId) {
            console.log(`[bookings] Incremented jobsCompleted for artisan=${artisanId}`);
        }

        // ── Dispatch side-effects ──────────────────────────────────────────────
        // Eliminates the second onDocumentUpdated trigger (onBookingDispatchEvent)
        // — halves Cloud Function invocations per booking write.
        await dispatch.handleDispatchEvent(before, after, bookingId);
    }
);

module.exports = { onBookingStatusChanged };
