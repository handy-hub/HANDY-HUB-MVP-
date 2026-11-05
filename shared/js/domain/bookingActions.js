/**
 * bookingActions.js — THE booking transition layer for both apps.
 *
 * Before this module, six screens each owned a private copy of the lifecycle:
 * artisan dashboard.html, jobs.html and bookings.html all wrote booking status
 * directly, and they did not agree. Only bookings.html routed an
 * inspection-track cancel to the Cloud Function that settles the callout fee;
 * jobs.html's generic `advanceJob(id, nextStatus)` wrote a raw status that
 * firestore.rules rejects on that track, surfacing as "Could not update status.
 * Try again." forever. The customer app had two more.
 *
 * Every legitimate transition now goes through performBookingAction(). One
 * table, matched line-for-line against firestore.rules, so a rejected write
 * means the rules changed — not that a screen guessed wrong.
 *
 * WHAT THIS LAYER GUARANTEES
 * ──────────────────────────
 * 1. The booking is re-read before acting. A card rendered 20 minutes ago does
 *    not get to assert what state the booking is in.
 * 2. The actor is checked against the booking's own customerId/artisanId.
 * 3. The transition is checked against the CURRENT status, not the rendered one.
 * 4. Server-owned transitions are dispatched to their Cloud Function, never
 *    written raw. (Inspection cancel settles the callout escrow; inspection
 *    completion and quote submission are server-only by construction.)
 * 5. The caller gets the authoritative post-action booking back, so it can route
 *    with bookingHref() instead of guessing where to go next.
 *
 * WHAT IT DOES NOT DO
 * ───────────────────
 * It does not touch money. Escrow release, refund and callout settlement are
 * driven by onBookingStatusChanged and the pricing CFs — see completeBooking.js
 * for why a client must never run its own settlement path.
 */

import { canStartWork } from './bookingSchedule.js';

/** Actions a client may legitimately request. */
export const ACTION = Object.freeze({
    ACCEPT:              'accept',
    DECLINE:             'decline',
    EN_ROUTE:            'en_route',
    START:               'start',
    JOB_DONE:            'job_done',
    CONFIRM_COMPLETE:    'confirm_complete',
    CANCEL:              'cancel',
    COMPLETE_INSPECTION: 'complete_inspection',
});

/** Result codes. Callers should branch on these, never on message text. */
export const RESULT = Object.freeze({
    OK:          'ok',
    CONFLICT:    'conflict',     // someone else moved the booking first
    NOT_ALLOWED: 'not_allowed',  // wrong party, or not a legal transition here
    NOT_FOUND:   'not_found',
    FAILED:      'failed',       // the write itself failed (network/rules)
});

/**
 * Why respondToJobOffer refused, when the offer is no longer this artisan's to
 * answer (functions/jobOffers.js offerError → HttpsError details.reason):
 *   expired      still open on the server, but past its expiresAtMs
 *   closed       already expired, withdrawn or accepted; or the booking moved on
 *   not_offered  re-offered to someone else
 * A screen told `offerGone` retires the offer card for good: neither Accept nor
 * Decline can succeed again, so neither is given back.
 */
export const OFFER_GONE_REASONS = Object.freeze(['expired', 'closed', 'not_offered']);

const norm = (v) => String(v == null ? '' : v).toLowerCase();

/**
 * The transition table. Each entry mirrors one clause of isValidBookingUpdate()
 * in firestore.rules — `from` is what the rule's `prev in [...]` allows, `keys`
 * is its hasOnly() set. Keep them in sync; a mismatch here shows up as a
 * permission-denied at runtime rather than a caught, explained conflict.
 */
const TRANSITIONS = {
    [ACTION.ACCEPT]: {
        actor: 'artisan',
        from:  ['pending'],
        to:    'accepted',
        stamp: 'acceptedAt',
        // artisanName is deliberately NOT written. onBookingStatusChanged stamps
        // the customer-visible identity from artisans/{uid} — name, photo,
        // rating, verification, job count. A client-asserted name is spoofable
        // and incomplete.
    },
    [ACTION.DECLINE]: {
        actor: 'artisan',
        from:  ['pending'],
        to:    'rejected',
        stamp: 'rejectedAt',
    },
    [ACTION.EN_ROUTE]: {
        actor: 'artisan',
        // Two distinct routes converge here. On the inspection track the artisan
        // travels BEFORE quoting (the callout fee is already escrowed), so
        // inspection_scheduled → en_route needs no approved quote. On the work
        // track, accepted → en_route requires one.
        from:  ['accepted', 'inspection_scheduled'],
        to:    'en_route',
        stamp: 'enRouteAt',
        // ── ACCEPTANCE IS NOT COMMENCEMENT ───────────────────────────────────
        // Two independent conditions, and they fail for different reasons, so
        // they are checked separately and explained separately. A quote that is
        // not approved is a commercial blocker; an appointment that has not
        // arrived is a calendar one, and telling an artisan the wrong one of
        // those sends them to fix the wrong thing.
        //
        // Mirrored by scheduleWindowOpen() in firestore.rules, which is what
        // actually enforces it — this check exists so the artisan gets a
        // sentence instead of a permission-denied.
        requires: (b) => norm(b.status) === 'inspection_scheduled' || b.quoteApproved === true,
        requiresWhy: 'The customer has not approved your quote yet.',
        scheduleGated: true,
    },
    [ACTION.START]: {
        actor: 'artisan',
        from:  ['en_route'],
        to:    'in_progress',
        stamp: 'arrivedAt',
    },
    [ACTION.JOB_DONE]: {
        actor: 'artisan',
        from:  ['in_progress'],
        to:    'awaiting',
        stamp: 'jobDoneAt',
    },
    [ACTION.CONFIRM_COMPLETE]: {
        actor: 'customer',
        from:  ['awaiting'],
        to:    'completed',
        stamp: 'completedAt',
    },
    [ACTION.CANCEL]: {
        actor: 'either',
        // The rules give the customer one more cancellable state than the
        // artisan: a customer may still cancel while the booking is pending.
        from:  ['pending', 'accepted', 'quoted'],
        to:    'cancelled',
        stamp: null,
        // Who cancelled is recorded (AR-12): a completion rate can only hold an
        // artisan to the cancellations they made, never the customer's.
        extra: (opts) => ({ cancellationReason: opts.reason || 'Cancelled', cancelledBy: opts.actor }),
        actorFrom: { artisan: ['accepted', 'quoted'] },
    },
};

/** Statuses that mean the booking is over — nothing further can be requested. */
const TERMINAL = ['completed', 'cancelled', 'rejected', 'unfulfilled'];

// The statuses functions/pricing.js cancelInspectionBooking accepts from an
// artisan (`pending` is left out: an offered artisan is not yet the booking's).
const INSPECTION_ARTISAN_CANCELLABLE = ['accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done', 'quoted'];

/**
 * Will the server accept this artisan cancelling the booking right now?
 *
 * Two authorities, one per track:
 *   inspection  cancelInspectionBooking (functions/pricing.js) — any state up to
 *               the quote decision; refused once the quote is approved ("use the
 *               dispute/refund flow instead").
 *   any other   the artisan cancel clause of firestore.rules — accepted or quoted.
 *
 * Screens offered "Cancel job" on approved inspection work, where the server
 * always refuses (Phase 0 WF-01). A screen offers Cancel only where this says
 * yes; it may offer it in fewer places, never in more.
 *
 * @param {object} booking
 * @returns {boolean}
 */
export function artisanCanCancel(booking) {
    const b = booking || {};
    const st = norm(b.status);
    if (norm(b.track) === 'inspection') {
        return b.quoteApproved !== true && INSPECTION_ARTISAN_CANCELLABLE.includes(st);
    }
    return ['accepted', 'quoted'].includes(st);
}

/**
 * Explain, in the customer's or artisan's own terms, why an action no longer
 * applies — using the state the booking is ACTUALLY in.
 */
function conflictMessage(current, action, actor) {
    const s = norm(current);
    if (s === 'cancelled')  return 'This booking was cancelled.';
    if (s === 'rejected')   return actor === 'artisan'
        ? 'This request was already declined.'
        : 'The professional declined this request.';
    if (s === 'completed')  return 'This job is already complete.';
    if (s === 'unfulfilled') return 'This request expired before anyone accepted it.';
    if (s === 'disputed')   return 'This booking is under dispute — support will be in touch.';

    if (action === ACTION.ACCEPT || action === ACTION.DECLINE) {
        return 'This request is no longer available.';
    }
    if (action === ACTION.CONFIRM_COMPLETE) {
        return 'This job is not waiting for your confirmation yet.';
    }
    return 'This booking has moved on — reopen it to see where it stands.';
}

/**
 * Perform a booking transition.
 *
 * @param {string} action  one of ACTION
 * @param {object} opts
 * @param {string} opts.bookingId
 * @param {'customer'|'artisan'} opts.actor      which side is acting
 * @param {string} opts.uid                      the acting user
 * @param {object} opts.databaseService
 * @param {object} [opts.pricingService]         required for inspection-track cancel
 * @param {string} [opts.reason]                 cancellation reason
 * @returns {Promise<{ok:boolean, code:string, message?:string, booking?:object, from?:string, to?:string,
 *                    reason?:string|null, offerGone?:boolean}>}
 *          reason/offerGone are set when answering a job offer is refused.
 */
export async function performBookingAction(action, opts = {}) {
    const { bookingId, actor, uid, databaseService, pricingService, reason } = opts;
    const spec = TRANSITIONS[action];

    if (!spec)                 return { ok: false, code: RESULT.NOT_ALLOWED, message: `Unknown action "${action}".` };
    if (!bookingId)            return { ok: false, code: RESULT.NOT_FOUND,   message: 'No booking specified.' };
    if (!databaseService)      return { ok: false, code: RESULT.FAILED,      message: 'Database unavailable.' };

    // ── 0. Answering a job offer is server-owned ────────────────────────────
    // An offered artisan cannot read the booking (firestore.rules: the booking
    // opens to an artisan only once they are its artisanId, which the server
    // sets on acceptance). They see job_offers/{bookingId} — the summary needed
    // to decide — and answer through respondToJobOffer, which checks the offer
    // is still theirs, still open and not expired, and that they may take work.
    if (action === ACTION.ACCEPT || action === ACTION.DECLINE) {
        if (actor !== 'artisan') {
            return { ok: false, code: RESULT.NOT_ALLOWED, message: 'That action belongs to the other party.' };
        }
        if (!pricingService?.respondToJobOffer) {
            return { ok: false, code: RESULT.FAILED, message: 'Responding to jobs is unavailable right now.' };
        }
        try {
            await pricingService.respondToJobOffer(bookingId, action === ACTION.ACCEPT ? 'accept' : 'decline');
        } catch (e) {
            return offerRefusal(e);
        }
        // Accepting grants the booking; declining does not, so there is nothing to re-read.
        if (action === ACTION.DECLINE) return { ok: true, code: RESULT.OK, booking: null, from: 'pending', to: 'rejected' };
        return after(databaseService, bookingId, { id: bookingId, status: 'pending' }, 'pending', 'accepted');
    }

    // ── 1. Authoritative read ────────────────────────────────────────────────
    let booking;
    try {
        const snap = await databaseService.getDocument('bookings', bookingId);
        if (!snap?.exists) {
            return { ok: false, code: RESULT.NOT_FOUND, message: 'This booking no longer exists.' };
        }
        booking = { id: bookingId, ...snap.data };
    } catch (e) {
        return { ok: false, code: RESULT.FAILED, message: 'Could not reach the booking. Check your connection.' };
    }

    const current = norm(booking.status);

    // ── 2. Is this actor a party to this booking? ────────────────────────────
    const isCustomer = uid && booking.customerId === uid;
    const isArtisan  = uid && booking.artisanId  === uid;
    if (uid && !isCustomer && !isArtisan) {
        return { ok: false, code: RESULT.NOT_ALLOWED, message: 'This booking is not yours.', booking };
    }
    if (spec.actor !== 'either' && spec.actor !== actor) {
        return { ok: false, code: RESULT.NOT_ALLOWED, message: 'That action belongs to the other party.', booking };
    }

    // ── 3. Is the transition legal FROM WHERE THE BOOKING ACTUALLY IS? ───────
    const allowedFrom = (spec.actorFrom && spec.actorFrom[actor]) || spec.from;
    if (!allowedFrom.includes(current)) {
        const code = TERMINAL.includes(current) || current !== '' ? RESULT.CONFLICT : RESULT.NOT_ALLOWED;
        return { ok: false, code, message: conflictMessage(current, action, actor), booking, from: current };
    }
    if (spec.requires && !spec.requires(booking)) {
        return { ok: false, code: RESULT.NOT_ALLOWED, message: spec.requiresWhy, booking, from: current };
    }

    // ── 3b. Has the appointment arrived? ─────────────────────────────────────
    // A booking with no appointment answers `allowed` unconditionally, so the
    // immediate flow and every emergency booking pass straight through.
    if (spec.scheduleGated) {
        const gate = canStartWork(booking);
        if (!gate.allowed) {
            return {
                ok: false, code: RESULT.NOT_ALLOWED,
                message: gate.reason, booking, from: current,
                opensAtMs: gate.opensAtMs,
            };
        }
    }

    // ── 4. Execute ───────────────────────────────────────────────────────────
    const n = new Date().toISOString();

    // Inspection-track cancellation is server-owned: settleCallout decides
    // refund vs release, and firestore.rules rejects a raw status write here.
    if (action === ACTION.CANCEL && norm(booking.track) === 'inspection') {
        if (!pricingService?.cancelInspectionBooking) {
            return { ok: false, code: RESULT.FAILED, message: 'Cancellation is unavailable right now.', booking };
        }
        try {
            await pricingService.cancelInspectionBooking(bookingId, reason || 'Cancelled');
        } catch (e) {
            return { ok: false, code: RESULT.FAILED, message: friendly(e), booking, from: current };
        }
        return after(databaseService, bookingId, booking, current, spec.to);
    }

    const payload = { status: spec.to, updatedAt: n };
    if (spec.stamp) payload[spec.stamp] = n;
    if (spec.extra) Object.assign(payload, spec.extra({ reason, actor }));

    try {
        await databaseService.updateDocument('bookings', bookingId, payload);
    } catch (e) {
        // A rules rejection here almost always means the booking moved between
        // our read and our write — re-read and explain rather than saying
        // "try again" at someone whose request was taken 3 seconds ago.
        const fresh = await safeRead(databaseService, bookingId);
        if (fresh && norm(fresh.status) !== current) {
            return {
                ok: false, code: RESULT.CONFLICT,
                message: conflictMessage(norm(fresh.status), action, actor),
                booking: fresh, from: current,
            };
        }
        return { ok: false, code: RESULT.FAILED, message: friendly(e), booking, from: current };
    }

    return after(databaseService, bookingId, booking, current, spec.to);
}

/**
 * Classify a refused offer answer by the server's own reason (HttpsError
 * details.reason). The message is read only when no reason came back — an
 * older deployment — and a message that says the offer has moved on is then
 * treated as gone too, so a stale card is not handed live buttons again.
 */
function offerRefusal(e) {
    const m = String(e?.message || '');
    const reason = typeof e?.details?.reason === 'string' ? e.details.reason : null;
    let code, offerGone;
    if (reason) {
        offerGone = OFFER_GONE_REASONS.includes(reason);
        code = offerGone ? RESULT.CONFLICT
             : (reason === 'not_eligible' || reason === 'unauthenticated') ? RESULT.NOT_ALLOWED
             : RESULT.FAILED;
    } else {
        offerGone = /expired|no longer|already|another professional|closed/i.test(m);
        code = offerGone ? RESULT.CONFLICT : RESULT.FAILED;
    }
    return { ok: false, code, reason, offerGone, message: m && !/^internal$/i.test(m) ? m : friendly(e) };
}

/** Re-read so the caller routes from authoritative state, not from an assumption. */
async function after(databaseService, bookingId, before, from, to) {
    const fresh = await safeRead(databaseService, bookingId);
    return {
        ok: true, code: RESULT.OK,
        booking: fresh || { ...before, status: to },
        from, to,
    };
}

async function safeRead(databaseService, bookingId) {
    try {
        const snap = await databaseService.getDocument('bookings', bookingId);
        return snap?.exists ? { id: bookingId, ...snap.data } : null;
    } catch { return null; }
}

function friendly(e) {
    const m = String(e?.message || '');
    if (/permission|insufficient/i.test(m)) return 'You are not able to do that right now.';
    if (/network|unavailable|offline/i.test(m)) return 'Connection problem — nothing was changed.';
    return m || 'Something went wrong. Nothing was changed.';
}
