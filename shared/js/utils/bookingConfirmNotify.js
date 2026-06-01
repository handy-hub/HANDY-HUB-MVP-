// ─────────────────────────────────────────────────────────────────────────────
// bookingConfirmNotify.js
// Called from book-step4.html (standard) AND book-emergency.html (emergency)
// whenever a booking is confirmed in the localStorage layer.
//
// Responsibilities:
//   1. Write the booking document to Firestore (bookings collection)
//   2. Send a confirmation notification to the customer
//   3. Send a new-job notification to the artisan (if artisanId is known)
//
// This is the bridge between the localStorage booking state (window.HH_Booking)
// and the authoritative Firestore backend. Both standard and emergency bookings
// must call this so Firestore is always the source of truth.
//
// Fire-and-forget: failures are logged but never surface to the UI so a Firestore
// outage cannot break the booking confirmation screen.
// ─────────────────────────────────────────────────────────────────────────────

import { getAppContainer }    from '../app/container.js';
import { createNotification } from '../services/notificationRepository.js';

/**
 * @param {{
 *   id:          string,           // booking ID e.g. HHB-250524-1430
 *   service:     string,
 *   proName:     string,
 *   artisanId:   string | null,
 *   dateDisplay: string,
 *   time:        string,
 *   total:       number,
 *   status:      string,           // 'pending' | 'Emergency'
 *   type:        string,           // 'standard' | 'emergency'
 *   ts:          string,           // ISO timestamp
 *   eta?:        string | null,    // for emergency bookings
 *   refCode?:    string | null,    // for emergency bookings
 *   notes?:      string,
 *   address?:    string,
 * }} booking
 */
export async function onBookingConfirmed(booking) {
    try {
        const { services: { authService, databaseService } } = getAppContainer();

        // Wait up to 4 s for auth to resolve — page may have just loaded
        const user = await Promise.race([
            authService.waitForUser(),
            new Promise(res => setTimeout(() => res(null), 4000)),
        ]);
        if (!user) {
            console.warn('[bookingConfirmNotify] No authenticated user — Firestore write skipped.');
            return;
        }

        const n   = new Date().toISOString();
        const isEmergency = booking.type === 'emergency';

        // ── Build Firestore document ─────────────────────────────────────────
        // Fields must satisfy the bookings Firestore security rules:
        //   customerId (string), artisanId (string), serviceType (string), createdAt (string)
        //   status must be 'pending' for the create rule to pass.
        const doc = {
            customerId:  user.uid,
            artisanId:   booking.artisanId || null,
            // Display fields — stored on the booking document so booking.html
            // can render cards from Firestore without additional lookups.
            serviceType: booking.service,
            service:     booking.service,       // alias for display layer
            proName:     booking.proName     || '',
            proPhoto:    booking.proPhoto    || null,
            proPhone:    booking.proPhone    || null,
            proRating:   booking.proRating   || null,
            proType:     booking.proType     || '',
            category:    booking.category    || '',
            dateDisplay: booking.dateDisplay || '',
            time:        booking.time        || '',
            total:       booking.total       || 0,
            notes:       booking.notes       || '',
            address:     booking.address     || '',
            payment:     booking.payment     || 'Wallet',
            status:      'pending',
            type:        isEmergency ? 'emergency' : 'standard',
            reviewLeft:  false,
            escrowId:    null,  // populated by holdBookingFunds after escrow is held
            ...(isEmergency && {
                eta:         booking.eta     || null,
                refCode:     booking.refCode || booking.id,
                isEmergency: true,
            }),
            refId:     booking.id,
            createdAt: n,
            updatedAt: n,
        };

        // ── Write to Firestore ───────────────────────────────────────────────
        try {
            // Use setDocument with the same ID as the localStorage record so that
            // future reads can cross-reference without a lookup.
            await databaseService.setDocument('bookings', booking.id, doc);
        } catch (dbErr) {
            // Do NOT rethrow — a Firestore failure must not break the UI confirmation
            console.warn('[bookingConfirmNotify] Firestore write failed:', dbErr.message);
        }

        // ── Notify customer ──────────────────────────────────────────────────
        const customerTitle   = isEmergency ? ' Emergency Booking Sent!' : ' Booking Confirmed!';
        const customerMessage = isEmergency
            ? `Your emergency request for ${booking.service} has been dispatched. ETA: ${booking.eta || 'being confirmed'}.`
            : `Your booking for ${booking.service} with ${booking.proName} on ${booking.dateDisplay} has been placed.`;

        await createNotification({
            receiverId: user.uid,
            type:       'Bookings',
            title:      customerTitle,
            message:    customerMessage,
            actionUrl:  'booking.html',
            metadata:   { bookingId: booking.id, artisanId: booking.artisanId },
        }).catch(err => console.warn('[bookingConfirmNotify] Customer notification failed:', err.message));

        // ── Notify artisan ───────────────────────────────────────────────────
        if (booking.artisanId) {
            const artisanTitle   = isEmergency ? ' Emergency Job Request!' : ' New Booking Request';
            const artisanMessage = isEmergency
                ? `You have an emergency job request for ${booking.service}. Respond immediately.`
                : `You have a new booking request for ${booking.service} on ${booking.dateDisplay}.`;

            await createNotification({
                receiverId: booking.artisanId,
                type:       'Bookings',
                title:      artisanTitle,
                message:    artisanMessage,
                actionUrl:  'dashboard.html',
                metadata:   { bookingId: booking.id, customerId: user.uid },
            }).catch(err => console.warn('[bookingConfirmNotify] Artisan notification failed:', err.message));
        }

    } catch (err) {
        console.warn('[bookingConfirmNotify] Unexpected error:', err.message);
    }
}
