/**
 * bookingRouter.js
 *
 * THE single routing contract for opening a booking from anywhere in the
 * customer app (bookings list card, dashboard resume card, notification tap,
 * detail sheet). Every "take me to this booking" action must resolve through
 * bookingHref()/openBooking() so a booking can never land on a screen that
 * lacks the control its current state needs.
 *
 * This exists because of the F2 dead-end: the inspection-track "pay callout
 * fee" control lives ONLY inside book-request.html's live console, reachable
 * via ?resume=BOOKING_ID. Before this module nothing produced that link, so a
 * customer who left the flow after requesting could never get back to pay —
 * the booking stalled at `accepted` forever.
 *
 * Routing table
 * ─────────────
 *   inspection track, pre-execution (pending…inspection_done)
 *                                   → book-request.html?resume=ID   (live console)
 *   any track, status 'quoted'      → quote-approval.html?bookingId=ID
 *   execution (en_route/in_progress/awaiting, or accepted AFTER quote approval)
 *                                   → live-tracking.html            (job stages)
 *   terminal (completed/cancelled/…)→ booking.html                 (detail/list)
 *
 * `accepted` is the fork: on the inspection track before the callout is paid it
 * means "pay your visit fee" (console); once a quote is approved `accepted`
 * means "job starting" (live tracking). quoteApproved disambiguates.
 */

const INSPECTION_PRE_EXECUTION = [
    'pending', 'dispatching', 'searching', 'dispatched', 'assigned',
    'accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done',
];

const EXECUTION = ['en_route', 'in_progress', 'awaiting'];

const TERMINAL = ['completed', 'cancelled', 'rejected', 'unfulfilled'];

function norm(v) {
    return String(v == null ? '' : v).toLowerCase();
}

/**
 * Resolve the destination URL for a booking object.
 * @param {object} b booking data — needs at least { id|bookingId, status, track, quoteApproved }
 * @returns {string} a customer-app-relative href
 */
export function bookingHref(b) {
    const id     = b?.id || b?.bookingId;
    const status = norm(b?.status);
    const track  = norm(b?.track);
    if (!id) return 'booking.html';

    const enc = encodeURIComponent(id);

    // The quote decision is the single most important customer action — always
    // route straight to it regardless of track.
    if (status === 'quoted') return `quote-approval.html?bookingId=${enc}`;

    if (track === 'inspection') {
        // Before a quote is approved the inspection console owns the whole
        // pre-execution journey (searching → pay callout → scheduled → inspected).
        if (!b?.quoteApproved && INSPECTION_PRE_EXECUTION.includes(status)) {
            return `book-request.html?resume=${enc}`;
        }
        // Quote approved → the job executes on the normal tracking screen.
        if (EXECUTION.includes(status) || (status === 'accepted' && b?.quoteApproved)) {
            return 'live-tracking.html';
        }
        if (TERMINAL.includes(status)) return 'booking.html';
        // Fallback for any inspection state not enumerated: the console can
        // render every inspection status, so it is the safe default.
        return `book-request.html?resume=${enc}`;
    }

    // ── Legacy / emergency track ──────────────────────────────────────────────
    if (EXECUTION.includes(status) || status === 'accepted') return 'live-tracking.html';
    return 'booking.html';
}

/**
 * Whether a booking is an inspection-track request still in flight (the customer
 * has an action pending or is waiting on the artisan). Drives the dashboard
 * resume card. Deliberately EXCLUDES terminal states and post-quote-approval
 * execution (those belong to live tracking, not the "resume your request" nudge).
 */
export function isResumableInspection(b) {
    if (norm(b?.track) !== 'inspection') return false;
    if (b?.quoteApproved) return false;
    const status = norm(b?.status);
    return INSPECTION_PRE_EXECUTION.includes(status) || status === 'quoted';
}

/**
 * A short, customer-facing summary of what the customer should do next for a
 * resumable inspection booking. Returned as { label, cta } so cards can render
 * a consistent "here's where you are / here's the button" pair.
 */
export function resumeSummary(b) {
    const status = norm(b?.status);
    const service = b?.serviceType || b?.service || b?.category || 'your request';
    if (status === 'quoted') {
        return { label: `Quote ready for ${service}`, cta: 'Review quote', urgent: true };
    }
    if (status === 'accepted' && !b?.calloutPaid) {
        return { label: `A professional accepted — pay your visit fee`, cta: 'Pay callout fee', urgent: true };
    }
    if (status === 'inspection_scheduled') {
        return { label: `Inspection booked for ${service}`, cta: 'View request', urgent: false };
    }
    if (status === 'inspection_done') {
        return { label: `Inspection done — quote on the way`, cta: 'View request', urgent: false };
    }
    if (['en_route', 'in_progress'].includes(status)) {
        return { label: `Your professional is inspecting ${service}`, cta: 'View request', urgent: false };
    }
    // pending / dispatching / searching / dispatched / assigned
    return { label: `Finding a professional for ${service}…`, cta: 'View request', urgent: false };
}

/** Navigate the browser to a booking's destination. */
export function openBooking(b) {
    window.location.href = bookingHref(b);
}
