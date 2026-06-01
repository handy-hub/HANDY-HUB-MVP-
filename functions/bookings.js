'use strict';

/**
 * functions/bookings.js — Booking lifecycle Cloud Function triggers
 *
 * Triggers:
 *   onBookingStatusChanged — fires on every booking document update.
 *
 * Notification rules:
 *   pending  → accepted   : customer notified ("Your booking was accepted!")
 *   pending  → rejected   : customer notified IF booking was pre-matched (not dispatch-controlled).
 *                           Dispatch-controlled rejections are handled by dispatch.js which
 *                           resets status to 'pending' and notifies "Searching for another…".
 *   accepted → in_progress: customer notified ("Job has started")
 *   *        → completed  : both parties notified + artisan jobsCompleted atomically incremented
 *   *        → cancelled  : both parties notified
 *
 * Side-effects:
 *   completed: artisan.jobsCompleted is incremented via FieldValue.increment (TOCTOU-safe).
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { FieldValue }        = require('firebase-admin/firestore');
const { FUNCTIONS_REGION, FIRESTORE_DB_ID } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');

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
    {
        from: 'pending',
        to:   'accepted',
        notify: 'customer',
        title:  '✅ Booking Accepted!',
        body:   (b) => `${b.artisanName || 'Your artisan'} has accepted your ${b.serviceType || 'service'} request.`,
        type:   'booking_accepted',
    },
    // NOTE: pending → rejected for DISPATCH-controlled bookings is handled by dispatch.js.
    // This rule handles pre-matched bookings (standard flow, or emergency pre-queried artisan)
    // where dispatch.js never took ownership (dispatchStatus was never 'dispatched').
    {
        from: 'pending',
        to:   'rejected',
        notify: 'customer',
        title:  'Professional Unavailable',
        body:   (b) => `The ${b.serviceType || 'service'} professional was unable to accept your booking. Please try booking again.`,
        type:   'booking_rejected',
        // Condition checked at runtime: only fire if the booking was NOT dispatch-controlled
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
        from: null,  // any status → completed
        to:   'completed',
        notify: 'both',
        title:  '🎉 Job Completed!',
        body:   (b) => `Your ${b.serviceType || 'service'} booking has been marked complete.`,
        artisanTitle: '💰 Job Completed',
        artisanBody:  (b) => `You completed a ${b.serviceType || 'service'} job. Earnings will be credited shortly.`,
        type:   'booking_completed',
    },
    {
        from: null,  // any status → cancelled
        to:   'cancelled',
        notify: 'both',
        title:  'Booking Cancelled',
        body:   (b) => `Your ${b.serviceType || 'service'} booking has been cancelled.`,
        artisanTitle: 'Booking Cancelled',
        artisanBody:  (b) => `A ${b.serviceType || 'service'} booking was cancelled by the customer.`,
        type:   'booking_cancelled',
    },
];

function _str(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }

const onBookingStatusChanged = onDocumentUpdated(
    { document: 'bookings/{bookingId}', region: FUNCTIONS_REGION },
    async (event) => {
        const before = event.data.before.data();
        const after  = event.data.after.data();
        const bookingId = event.params.bookingId;

        const prevStatus = _str(before.status);
        const nextStatus = _str(after.status);

        if (prevStatus === nextStatus) return;  // no status change — metadata-only update

        const rule = TRANSITIONS.find(t =>
            (t.from === null || _str(t.from) === prevStatus) &&
            _str(t.to) === nextStatus
        );

        if (!rule) {
            console.log(`[bookings] No notification rule for ${prevStatus}→${nextStatus} booking=${bookingId}`);
        }

        const customerId = after.customerId || after.userId || null;
        const artisanId  = after.artisanId  || null;
        const ctx        = {
            bookingId,
            serviceType:  after.serviceType  || after.service || 'Service',
            artisanName:  after.artisanName  || after.proName || null,
            customerName: after.customerName || null,
        };

        const promises = [];

        if (rule) {
            // For the rejected rule: only notify if dispatch.js didn't own this booking
            const shouldSkip = rule.onlyIfNotDispatched &&
                (before.dispatchStatus === 'dispatched' || before.dispatchStatus === 'searching');

            if (!shouldSkip) {
                if ((rule.notify === 'customer' || rule.notify === 'both') && customerId) {
                    promises.push(
                        sendNotification(customerId, {
                            title:     rule.title,
                            body:      typeof rule.body === 'function' ? rule.body(ctx) : rule.body,
                            type:      rule.type,
                            bookingId,
                        }).catch(err => console.error('[bookings] customer notif:', err?.message))
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
                        }).catch(err => console.error('[bookings] artisan notif:', err?.message))
                    );
                }
            }
        }

        // ── Side-effect: atomically increment artisan's jobsCompleted on completion ──
        // Using FieldValue.increment is TOCTOU-safe — no read-then-write race condition.
        if (nextStatus === 'completed' && artisanId) {
            promises.push(
                db().collection('artisans').doc(artisanId).update({
                    jobsCompleted: FieldValue.increment(1),
                    updatedAt:     new Date().toISOString(),
                }).catch(err => console.error('[bookings] jobsCompleted increment error:', err?.message))
            );
        }

        await Promise.all(promises);

        if (rule) {
            console.log(`[bookings] Dispatched: ${prevStatus}→${nextStatus} booking=${bookingId}`);
        }
        if (nextStatus === 'completed' && artisanId) {
            console.log(`[bookings] Incremented jobsCompleted for artisan=${artisanId}`);
        }
    }
);

module.exports = { onBookingStatusChanged };
