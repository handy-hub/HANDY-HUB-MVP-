/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * CommonJS mirror of shared/js/domain/bookingRouter.js, produced by
 * scripts/build-functions-shared.cjs so the Cloud Functions runtime (which
 * only receives the functions/ directory, and cannot import an ES module)
 * decides with exactly the same rules and the same numbers as the browser
 * (and, for appointments, firestore.rules).
 *
 * Edit the source module and re-run:  node scripts/build-functions-shared.cjs
 * `npm run lint` fails if this file has drifted from its source.
 */

'use strict';
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
 *                                   → live-tracking.html?bookingId=ID (job stages)
 *   terminal (completed/resolved/cancelled/…)→ booking.html        (detail/list)
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

// 'resolved' is what resolveDispute writes for every outcome (functions/disputes.js).
const TERMINAL = ['completed', 'resolved', 'cancelled', 'rejected', 'unfulfilled'];

function norm(v) {
    return String(v == null ? '' : v).toLowerCase();
}

/**
 * Resolve the destination URL for a booking object.
 * @param {object} b booking data — needs at least { id|bookingId, status, track, quoteApproved }
 * @returns {string} a customer-app-relative href
 */
function bookingHref(b) {
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
            return `live-tracking.html?bookingId=${enc}`;
        }
        if (TERMINAL.includes(status)) return 'booking.html';
        // Fallback for any inspection state not enumerated: the console can
        // render every inspection status, so it is the safe default.
        return `book-request.html?resume=${enc}`;
    }

    // ── Legacy / emergency track ──────────────────────────────────────────────
    if (EXECUTION.includes(status) || status === 'accepted') {
        return `live-tracking.html?bookingId=${enc}`;
    }
    return 'booking.html';
}

/**
 * Whether a booking is an inspection-track request still in flight (the customer
 * has an action pending or is waiting on the artisan). Drives the dashboard
 * resume card. Deliberately EXCLUDES terminal states and post-quote-approval
 * execution (those belong to live tracking, not the "resume your request" nudge).
 */
function isResumableInspection(b) {
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
function resumeSummary(b) {
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

/**
 * Where a notification tap should land.
 *
 * Every booking notification is written with `metadata.bookingId`
 * (functions/bookings.js), but its `actionUrl` is a generic page —
 * 'booking.html' for the customer, 'dashboard.html' for the artisan — because
 * the backend cannot know which screen will be able to act on the booking by
 * the time somebody taps. Exactly one rule in the whole file overrides it.
 *
 * So "your professional accepted" opened a LIST, and the customer had to find
 * the booking the notification was already about. The id was in hand the entire
 * time; nothing read it.
 *
 * Reading the booking is what makes the destination correct, so it is worth one
 * round trip — but never worth a hang. If the read is slow or fails, we fall
 * back to the notification's own actionUrl, which is exactly today's behaviour.
 *
 * @param {object}   notif      the notification record
 * @param {function} getBooking async (id) => ({ exists, data }) | null
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=1200] give up and use actionUrl after this
 * @returns {Promise<string|null>} href to navigate to, or null for "do nothing"
 */
async function notificationHref(notif, getBooking, { timeoutMs = 1200 } = {}) {
    const fallback  = notif?.actionUrl || null;
    const bookingId = notif?.metadata?.bookingId || null;

    if (!bookingId || typeof getBooking !== 'function') return fallback;

    try {
        const timeout = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), timeoutMs));
        const snap    = await Promise.race([getBooking(bookingId), timeout]);

        if (snap === '__timeout__') return fallback;
        if (!snap || snap.exists === false) return fallback;

        const data = snap.data || snap;
        return bookingHref({ ...data, id: data.id || bookingId });
    } catch {
        // A failed read is not a reason to strand the tap.
        return fallback;
    }
}

/** Navigate the browser to a booking's destination. */
function openBooking(b) {
    window.location.href = bookingHref(b);
}

// ── CommonJS surface ─────────────────────────────────────────────────────────
module.exports = {
    bookingHref,
    isResumableInspection,
    resumeSummary,
    notificationHref,
    openBooking,
};
