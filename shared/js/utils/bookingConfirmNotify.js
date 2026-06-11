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
import { checkAndRecord, showRateLimitToast } from '../services/rateLimitService.js';

// In-flight guard — prevents the same confirmation firing twice from double-click
// or rapid page navigation. One pending write at a time per browser tab.
let _writePending = false;

// localStorage key for bookings that failed all Firestore write attempts.
// Checked and retried by the next successful page load.
const PENDING_WRITES_KEY = '_hhb_pending_writes';

/**
 * Attempt fn() up to maxAttempts times with exponential back-off (1s, 2s, 3s…).
 * Re-throws on the final failure so callers can handle the exhaustion case.
 */
async function _retryWrite(fn, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxAttempts) throw err;
            await new Promise(res => setTimeout(res, attempt * 1000));
        }
    }
}

/**
 * Queue a failed booking write so it can be retried on the next page load.
 * Keeps a sliding window of the 10 most-recent pending items.
 */
function _queuePendingWrite(bookingId, doc) {
    try {
        const pending = JSON.parse(localStorage.getItem(PENDING_WRITES_KEY) || '[]');
        const already = pending.some(p => p.id === bookingId);
        if (!already) {
            pending.push({ id: bookingId, doc, queuedAt: Date.now() });
            localStorage.setItem(PENDING_WRITES_KEY, JSON.stringify(pending.slice(-10)));
        }
    } catch {}
}

/**
 * Flush any bookings queued by _queuePendingWrite.
 * Called opportunistically — failures are silently ignored so this never blocks.
 */
export async function flushPendingBookingWrites(databaseService) {
    if (!databaseService) return;
    let pending;
    try {
        pending = JSON.parse(localStorage.getItem(PENDING_WRITES_KEY) || '[]');
        if (!pending.length) return;
    } catch { return; }

    const remaining = [];
    for (const item of pending) {
        try {
            await databaseService.setDocument('bookings', item.id, item.doc);
        } catch {
            remaining.push(item);
        }
    }

    try {
        if (remaining.length) {
            localStorage.setItem(PENDING_WRITES_KEY, JSON.stringify(remaining));
        } else {
            localStorage.removeItem(PENDING_WRITES_KEY);
        }
    } catch {}
}

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
    // ── In-flight guard ──────────────────────────────────────────────────────
    // Prevents double-click or rapid navigation from firing two concurrent writes.
    if (_writePending) {
        console.warn('[bookingConfirmNotify] Write already in progress — skipped duplicate call.');
        return;
    }
    _writePending = true;

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

        // ── Frontend rate limit ──────────────────────────────────────────────
        const actionKey = booking.type === 'emergency' ? 'EMERGENCY_BOOKING' : 'BOOKING_CREATE';
        const rl = checkAndRecord(actionKey, user.uid);
        if (!rl.allowed) {
            showRateLimitToast(rl.waitMs, 'booking');
            console.warn('[bookingConfirmNotify] Rate limited — Firestore write skipped.');
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

        // ── Write to Firestore (3 attempts, 1s/2s/3s back-off) ──────────────
        // Use setDocument with the same ID as the localStorage record so that
        // future reads can cross-reference without a lookup.
        try {
            await _retryWrite(() => databaseService.setDocument('bookings', booking.id, doc));
        } catch (dbErr) {
            // All retries exhausted — queue for the next page load.
            // Do NOT rethrow: a Firestore failure must not break the confirmation UI.
            console.warn('[bookingConfirmNotify] Firestore write failed after retries — queued for retry:', dbErr.message);
            _queuePendingWrite(booking.id, doc);
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
    } finally {
        _writePending = false;
    }
}
