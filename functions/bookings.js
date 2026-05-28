'use strict';

/**
 * functions/bookings.js — Booking lifecycle Cloud Function triggers
 *
 * Triggers:
 *   onBookingStatusChanged — fires on every booking document update.
 *     Sends push notifications to the relevant party when status transitions:
 *
 *     pending  → accepted   : customer notified ("Your booking was accepted!")
 *     pending  → rejected   : customer notified ("Your booking was declined")
 *     accepted → in_progress: customer notified ("Job has started")
 *     *        → completed  : both parties notified
 *     *        → cancelled  : both parties notified
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { FUNCTIONS_REGION }  = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');

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
    {
        from: 'pending',
        to:   'rejected',
        notify: 'customer',
        title:  'Booking Declined',
        body:   (b) => `Your ${b.serviceType || 'service'} request was declined. Please try booking another professional.`,
        type:   'booking_rejected',
    },
    {
        from: 'accepted',
        to:   'in_progress',
        notify: 'customer',
        title:  '🔧 Job Started',
        body:   (b) => `${b.artisanName || 'Your artisan'} has started working on your ${b.serviceType || 'service'} request.`,
        type:   'booking_started',
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

        if (prevStatus === nextStatus) return;  // no status change → skip

        const rule = TRANSITIONS.find(t =>
            (t.from === null || _str(t.from) === prevStatus) &&
            _str(t.to) === nextStatus
        );

        if (!rule) {
            console.log(`[bookings] No notification rule for ${prevStatus}→${nextStatus} booking=${bookingId}`);
            return;
        }

        const customerId = after.customerId || after.userId || null;
        const artisanId  = after.artisanId  || null;
        const ctx        = {
            bookingId,
            serviceType:  after.serviceType  || after.service || 'Service',
            artisanName:  after.artisanName  || null,
            customerName: after.customerName || null,
        };

        const promises = [];

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

        await Promise.all(promises);
        console.log(`[bookings] Dispatched: ${prevStatus}→${nextStatus} booking=${bookingId}`);
    }
);

module.exports = { onBookingStatusChanged };
