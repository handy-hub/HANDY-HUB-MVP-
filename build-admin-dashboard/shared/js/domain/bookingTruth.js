/**
 * bookingTruth.js — THE single projection from a backend booking record to
 * everything a UI is allowed to say about that booking's money, identity and
 * payment state.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The booking document written by Cloud Functions is already the authoritative
 * record. The failure was never in the ledger — it was that six surfaces each
 * hand-rolled their own read of it, with their own field precedence and their
 * own invented fallbacks. That produced, in production:
 *
 *   • a "PAYMENT RECEIPT · Paid · GHS 65.00" for a GHS 1.00 job, because
 *     review.html read a legacy localStorage history the inspection flow never
 *     writes and fell through to `(state.total || last.total || 65)`
 *   • a booking ID built from `new Date()` at render time, so the receipt named
 *     a booking that does not exist
 *   • "Approve & Pay GHS 1.00" when the callout credit made the amount due
 *     GHS 0.00 — the ledger was right, the sentence was wrong
 *   • the same artisan rendered as "Test Artisan", "Professional", "Artisan"
 *     and "Your Artisan" on four screens, two of which authorise payment
 *
 * THE RULE THIS MODULE ENFORCES
 * ─────────────────────────────
 * NEVER INVENT MONEY, AN IDENTITY, OR AN ID.
 *
 * Every accessor returns either a value derived from the booking record, or
 * `null` meaning UNRESOLVED. `null` is not zero. Callers must render an honest
 * unresolved state ("—", "Loading…", an error) rather than substituting a
 * number. GHS 0.00 is just as much a lie as GHS 65.00 when the truth is unknown.
 *
 * Local storage may still back drafts and non-authoritative UI state. It may
 * never reach this module: the only input is a booking document.
 *
 * NO IMPORTS — evaluates in every browser context and is consumed by the
 * customer app, artisan app and the Node test suite alike.
 */

// ── Primitives ───────────────────────────────────────────────────────────────

/** A number that came from the record, or null. Never coerces absence to 0. */
export function money(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? parseFloat(n.toFixed(2)) : null;
}

/** Format for display. Unresolved renders as an em-dash, never as a number. */
export function formatMoney(v, { currency = 'GHS', dash = '—' } = {}) {
    const n = money(v);
    return n === null ? dash : `${currency} ${n.toFixed(2)}`;
}

function text(v) {
    const s = (v === null || v === undefined) ? '' : String(v).trim();
    return s === '' ? null : s;
}

const norm = (s) => String(s || '').trim().toLowerCase();

// Placeholder identities that earlier code wrote INTO the record as if they were
// real names. They must not be treated as a resolved identity on read, or the
// bug becomes permanent the moment it is persisted once.
const PLACEHOLDER_NAMES = new Set([
    'professional', 'artisan', 'your artisan', 'your professional',
    'a professional', 'customer', 'the customer', 'service', 'unknown',
]);

function realName(v) {
    const s = text(v);
    if (s === null) return null;
    return PLACEHOLDER_NAMES.has(norm(s)) ? null : s;
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * The booking's own id. Read ONLY from the record (or the id the caller loaded
 * it by). There is deliberately no generator here: a booking that exists has an
 * id, and a booking that does not must not be given one for display.
 */
export function resolveBookingId(booking, loadedById = null) {
    return text(booking?.id) || text(booking?.bookingId) || text(loadedById);
}

/**
 * ONE precedence for the assigned professional, used by every surface.
 *
 * `artisanId` is set when an artisan actually accepts. `currentArtisanId` is the
 * dispatcher's in-flight offer — a candidate, not an assignment. Treating the
 * two as interchangeable is how a customer came to see a name on the tracking
 * screen for a booking that nobody had accepted yet.
 */
export function resolveArtisan(booking) {
    const b = booking || {};
    const assignedId = text(b.artisanId);
    const offeredId  = text(b.currentArtisanId);

    // `artisanId` is set by the dispatcher when it OFFERS the job (so the
    // artisan's own query can surface it), not when the artisan accepts. Treating
    // its presence as assignment would name a professional to the customer before
    // anyone had agreed to come. Assignment requires the status to have moved past
    // the dispatch phase.
    const DISPATCH_PHASE = ['pending', 'dispatching', 'searching', 'dispatched'];
    const isAssigned = assignedId !== null && !DISPATCH_PHASE.includes(norm(b.status));
    const id         = assignedId || offeredId;

    const name = isAssigned
        ? (realName(b.artisanName) || realName(b.proName) || realName(b.currentArtisanName))
        : realName(b.currentArtisanName);

    return {
        id,
        isAssigned,
        // null means "no real name available" — the caller decides what generic
        // wording to show, and does so knowingly.
        name,
        photo:  text(b.artisanPhoto) || text(b.proPhoto) || text(b.currentArtisanPhoto),
        rating: money(b.artisanRating ?? b.currentArtisanRating),
        trade:  text(b.artisanCategory) || text(b.currentArtisanCategory),
        // Stamped server-side on accept (onBookingStatusChanged) so the customer
        // can judge who is coming. `verified` is a tri-state: true / false /
        // null-meaning-unknown — an unstamped booking must not read as unverified.
        verified: typeof b.artisanVerified === 'boolean' ? b.artisanVerified : null,
        jobsCompleted: Number.isFinite(Number(b.artisanJobsCompleted))
            ? Number(b.artisanJobsCompleted) : null,
    };
}

export function resolveCustomer(booking) {
    const b = booking || {};
    return {
        id:    text(b.customerId),
        // customerFirstName is written server-side by createInspectionBooking.
        name:  realName(b.customerFirstName) || realName(b.customerName) || realName(b.customerFullName),
        phone: text(b.customerPhone),
    };
}

/** Initials for an avatar, or null when there is no real name to derive from. */
export function initialsOf(name) {
    const s = realName(name);
    if (!s) return null;
    return s.split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || null;
}

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * The financial projection of a booking. Each field is a real number or null.
 *
 * The semantics are deliberately NOT collapsed into one figure — callout fee,
 * gross quote, credit, additional amount due, escrow held and final settlement
 * are distinct facts about distinct moments, and a receipt that merges them
 * cannot be audited.
 */
export function resolveMoney(booking) {
    const b = booking || {};
    const isInspection = norm(b.track) === 'inspection';

    const calloutFee  = money(b.calloutFee);
    const calloutPaid = b.calloutPaid === true;
    const jobQuote    = money(b.jobQuote);

    // Credit: authoritative once the backend has stamped it at approval.
    // Before approval, quotes.js writes calloutCreditPreview at quote-submit
    // time using the SAME server-side formula, so the client never computes it.
    const creditSettled  = money(b.calloutCredit);
    const creditPreview  = money(b.calloutCreditPreview);
    const calloutCredit  = b.quoteApproved === true ? creditSettled
                         : (creditPreview !== null ? creditPreview : creditSettled);

    // Additional amount the customer must fund on top of the credit.
    const dueSettled = money(b.escrowHeldAmount);
    const duePreview = money(b.amountDuePreview);
    const amountDue  = b.quoteApproved === true ? dueSettled
                     : (duePreview !== null ? duePreview : dueSettled);

    return {
        isInspection,
        currency: 'GHS',

        calloutFee,
        calloutPaid,
        // What the customer actually parted with for the visit.
        calloutCharged: calloutPaid ? calloutFee : null,

        jobQuote,
        labourCost:    money(b.labourCost),
        materialsCost: money(b.materialsCost),

        calloutCredit,
        amountDue,

        quoteApproved: b.quoteApproved === true,
        escrowHeld:    money(b.escrowHeldAmount),

        commissionRate: money(b.commissionRate),
        artisanEarns:   money(b.artisanEarns),
        platformFee:    money(b.platformFee),

        // Callout escrow outcome, written on the booking by settleCallout:
        // 'released' (paid to the artisan) or 'refunded' (returned to the wallet).
        calloutSettled:  norm(b.calloutSettled) || null,
        // The JOB escrow's state does NOT live on the booking — it lives on
        // escrow/{escrowId}. Only its id is here; resolvePaymentState needs the
        // escrow document itself to say anything about held/released/refunded.
        escrowId:        text(b.escrowId),
        calloutEscrowId: text(b.calloutEscrowId),
    };
}

/**
 * Total the customer has actually been charged for this booking, to date.
 *
 * Returns null unless every component needed is known — a partially-known total
 * is a false total. The callout fee and the additional escrow funding are the
 * only two customer debits in the lifecycle; the credit is not a third debit,
 * it is the callout fee being spent, so it must never be added again.
 */
export function totalCharged(booking) {
    const m = resolveMoney(booking);

    const callout = m.calloutPaid ? m.calloutFee : 0;
    if (m.calloutPaid && m.calloutFee === null) return null;   // paid an unknown amount

    if (!m.quoteApproved) return money(callout);

    if (m.amountDue === null) return null;                     // approved but unknown funding
    return money(callout + m.amountDue);
}

// ── Payment / escrow state ───────────────────────────────────────────────────

/**
 * Payment state as an explicit enum, derived only from persisted fields.
 *
 * 'unresolved' exists so a caller can never mistake "we have not loaded this"
 * for "nothing was paid". A timeout, an aborted request or a missing cache all
 * land here — none of them are evidence of failure.
 */
export const PAYMENT_STATE = {
    UNRESOLVED:   'unresolved',
    NONE_DUE:     'none_due',
    AWAITING:     'awaiting',
    HELD:         'held',
    RELEASED:     'released',
    REFUNDED:     'refunded',
    FAILED:       'failed',
};

/**
 * @param {object} booking  the booking record
 * @param {object|null} escrow  the escrow/{booking.escrowId} document, when one
 *   exists and has been loaded. Its `status` is the ONLY authority on whether
 *   job funds are held, released or refunded — releaseEscrow writes it there and
 *   writes no equivalent flag onto the booking.
 *
 * Deliberately ignores booking.status. `status === 'completed'` is written by
 * the client when the customer confirms the job; the escrow release that should
 * follow is a separate server call that can fail. Treating completion as proof
 * of payout would print "Paid out" on a receipt for money still sitting in
 * escrow — the same class of error as the fabricated GHS 65.00 total.
 */
export function resolvePaymentState(booking, escrow = null) {
    if (!booking || typeof booking !== 'object') return PAYMENT_STATE.UNRESOLVED;

    const m = resolveMoney(booking);

    // ── Job escrow exists: its document is the authority ─────────────────────
    if (m.escrowId) {
        const st = norm(escrow?.status);
        if (!st) return PAYMENT_STATE.UNRESOLVED;   // not loaded → say nothing
        if (st === 'refunded') return PAYMENT_STATE.REFUNDED;
        if (st === 'released') return PAYMENT_STATE.RELEASED;
        if (st === 'held' || st === 'frozen') return PAYMENT_STATE.HELD;
        if (st === 'failed')   return PAYMENT_STATE.FAILED;
        return PAYMENT_STATE.UNRESOLVED;
    }

    // ── No job escrow ────────────────────────────────────────────────────────
    if (m.quoteApproved) {
        if (m.amountDue === null) return PAYMENT_STATE.UNRESOLVED;
        if (m.amountDue > 0)      return PAYMENT_STATE.UNRESOLVED;  // should exist; cannot confirm
        // Fully covered by the callout credit — the callout escrow carried the job.
        if (m.calloutSettled === 'released') return PAYMENT_STATE.RELEASED;
        if (m.calloutSettled === 'refunded') return PAYMENT_STATE.REFUNDED;
        return m.calloutPaid ? PAYMENT_STATE.NONE_DUE : PAYMENT_STATE.UNRESOLVED;
    }

    if (m.calloutPaid) {
        if (m.calloutSettled === 'released') return PAYMENT_STATE.RELEASED;
        if (m.calloutSettled === 'refunded') return PAYMENT_STATE.REFUNDED;
        return PAYMENT_STATE.HELD;
    }

    return PAYMENT_STATE.AWAITING;
}

/** Customer-facing wording for a payment state. Never says "Paid" speculatively. */
export function paymentStateLabel(state) {
    switch (state) {
        case PAYMENT_STATE.NONE_DUE: return 'No further payment due';
        case PAYMENT_STATE.AWAITING: return 'Awaiting payment';
        case PAYMENT_STATE.HELD:     return 'Held in escrow';
        case PAYMENT_STATE.RELEASED: return 'Paid out';
        case PAYMENT_STATE.REFUNDED: return 'Refunded';
        case PAYMENT_STATE.FAILED:   return 'Payment failed';
        default:                     return 'Not available';
    }
}

// ── Receipt ──────────────────────────────────────────────────────────────────

/**
 * The receipt projection. `resolved:false` means the caller MUST render an
 * unresolved state — not a receipt with blanks, and never a fabricated figure.
 *
 * A receipt is only meaningful for a booking that reached settlement, so the
 * projection reports `settled` separately from `resolved`: a real booking that
 * has not completed yet is resolvable but is not a receipt.
 */
export function resolveReceipt(booking, loadedById = null, escrow = null) {
    const bookingId = resolveBookingId(booking, loadedById);

    if (!booking || typeof booking !== 'object' || !bookingId) {
        return {
            resolved: false,
            reason:   'no-booking',
            bookingId: bookingId || null,
        };
    }

    const m       = resolveMoney(booking);
    const artisan = resolveArtisan(booking);
    const state   = resolvePaymentState(booking, escrow);
    const total   = totalCharged(booking);
    const status  = norm(booking.status);

    const lines = [];
    if (m.calloutPaid && m.calloutFee !== null) {
        lines.push({ key: 'callout', label: 'Callout / inspection fee', amount: m.calloutFee });
    }
    if (m.jobQuote !== null) {
        lines.push({ key: 'quote', label: 'Job quote', amount: m.jobQuote });
    }
    if (m.calloutCredit !== null && m.calloutCredit > 0) {
        lines.push({ key: 'credit', label: 'Callout fee credited', amount: -m.calloutCredit });
    }
    if (m.quoteApproved && m.amountDue !== null) {
        lines.push({ key: 'due', label: 'Additional amount paid', amount: m.amountDue });
    }

    return {
        resolved:  true,
        settled:   status === 'completed',
        reason:    null,
        bookingId,
        status,
        service:   text(booking.serviceType) || text(booking.service),
        completedAt: text(booking.completedAt) || text(booking.updatedAt) || null,
        artisan,
        money:     m,
        lines,
        totalCharged: total,
        paymentState: state,
        paymentLabel: paymentStateLabel(state),
    };
}

// ── The artisan's information contract ───────────────────────────────────────

/**
 * Lifecycle phases, named so an artisan can tell the INSPECTION visit apart from
 * the WORK visit. Both run accepted → en_route → in_progress on the same booking,
 * which is correct domain logic but rendered identically — an artisan who had
 * just been paid for an inspection saw "ACCEPTED · Mark En Route" again with
 * nothing explaining that a second, different visit had begun.
 */
export const JOB_PHASE = {
    REQUEST:          'request',
    AWAITING_CALLOUT: 'awaiting_callout',
    INSPECTION:       'inspection',
    QUOTING:          'quoting',
    AWAITING_QUOTE:   'awaiting_quote',
    WORK:             'work',
    AWAITING_CONFIRM: 'awaiting_confirm',
    CLOSED:           'closed',
};

const PHASE_COPY = {
    [JOB_PHASE.REQUEST]:          { label: 'New request',        cycle: null,         hint: 'Decide whether to take this job.' },
    [JOB_PHASE.AWAITING_CALLOUT]: { label: 'Awaiting callout fee', cycle: 'Inspection', hint: 'Accepted. The customer is paying the callout fee.' },
    [JOB_PHASE.INSPECTION]:       { label: 'Inspection visit',   cycle: 'Inspection', hint: 'Travel, assess the problem, then complete the inspection.' },
    [JOB_PHASE.QUOTING]:          { label: 'Quote needed',       cycle: 'Inspection', hint: 'Inspection done — send the customer a fixed quote.' },
    [JOB_PHASE.AWAITING_QUOTE]:   { label: 'Awaiting approval',  cycle: 'Inspection', hint: 'Quote sent. Waiting for the customer to approve.' },
    [JOB_PHASE.WORK]:             { label: 'Work visit',         cycle: 'Work',       hint: 'Quote approved and paid into escrow — go and do the job.' },
    [JOB_PHASE.AWAITING_CONFIRM]: { label: 'Awaiting confirmation', cycle: 'Work',    hint: 'Job marked done. Waiting for the customer to release payment.' },
    [JOB_PHASE.CLOSED]:           { label: 'Closed',             cycle: null,         hint: '' },
};

export function resolveJobPhase(booking) {
    const b = booking || {};
    const st = norm(b.status);
    const isInspection = norm(b.track) === 'inspection';

    if (['completed', 'cancelled', 'rejected', 'unfulfilled'].includes(st)) return JOB_PHASE.CLOSED;
    if (['pending', 'dispatching', 'searching', 'dispatched'].includes(st))  return JOB_PHASE.REQUEST;
    if (st === 'awaiting') return JOB_PHASE.AWAITING_CONFIRM;

    if (isInspection && !b.quoteApproved) {
        if (st === 'accepted' && !b.calloutPaid) return JOB_PHASE.AWAITING_CALLOUT;
        if (st === 'inspection_done')            return JOB_PHASE.QUOTING;
        if (st === 'quoted')                     return JOB_PHASE.AWAITING_QUOTE;
        return JOB_PHASE.INSPECTION;
    }
    if (st === 'quoted') return JOB_PHASE.AWAITING_QUOTE;
    return JOB_PHASE.WORK;
}

/**
 * What the artisan is entitled to at this point, and what is still conditional.
 *
 * The job card previously read `b.jobQuote || b.total || b.price || 0`. On the
 * inspection track none of those exist before a quote is raised, so the artisan
 * was shown "GHS 0" — which reads as "this job pays nothing" — while a real
 * callout fee was waiting for them. calloutFee was simply never in the chain.
 */
export function resolveArtisanCompensation(booking) {
    const m = resolveMoney(booking);

    if (m.jobQuote !== null) {
        return {
            amount:      m.artisanEarns !== null ? m.artisanEarns : null,
            gross:       m.jobQuote,
            label:       'Your earnings from this quote',
            conditional: !m.quoteApproved,
            note: m.quoteApproved
                ? 'Approved and secured in escrow.'
                : 'If the customer approves this quote.',
            commissionRate: m.commissionRate,
        };
    }

    if (m.calloutFee !== null) {
        return {
            amount:      m.calloutFee,
            gross:       m.calloutFee,
            label:       'Callout / inspection fee',
            // Before the customer pays, the fee is real but not yet secured.
            conditional: !m.calloutPaid,
            note: m.calloutPaid
                ? 'Secured in escrow for this visit. The job price is quoted separately, after you inspect.'
                : 'Payable once the customer funds it. The job price is quoted separately, after you inspect.',
            commissionRate: m.commissionRate,
        };
    }

    // Unknown is unknown — never render it as zero.
    return { amount: null, gross: null, label: 'Compensation', conditional: true,
             note: 'Not available yet.', commissionRate: null };
}

/** Straight-line km between two points, or null when either is unusable. */
export function distanceKm(aLat, aLng, bLat, bLng) {
    const ns = [aLat, aLng, bLat, bLng].map(Number);
    if (ns.some(n => !Number.isFinite(n))) return null;
    if ((ns[0] === 0 && ns[1] === 0) || (ns[2] === 0 && ns[3] === 0)) return null;  // null island
    const R = 6371, toRad = d => d * Math.PI / 180;
    const dLat = toRad(ns[2] - ns[0]), dLng = toRad(ns[3] - ns[1]);
    const s = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(ns[0])) * Math.cos(toRad(ns[2])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Distance wording. "0.0 km" reads as "unknown" even when it is literally true,
 * so anything under 100 m is described rather than rounded to zero. A null
 * distance is omitted entirely — never rendered as 0.
 */
export function formatDistance(km) {
    if (km === null || km === undefined || !Number.isFinite(Number(km))) return null;
    const n = Number(km);
    if (n < 0.1) return 'under 100 m away';
    if (n < 10)  return `${n.toFixed(1)} km away`;
    return `${Math.round(n)} km away`;
}

/**
 * THE ARTISAN'S VIEW OF THE BOOKING — one projection, consumed by the job card,
 * the detail sheet and every lifecycle screen, so the job stays understandable
 * as it moves.
 *
 * Every field here already existed on the booking document the artisan's own
 * query returns. Nothing new is fetched and no security rule is relaxed: the
 * description, photos, address and coordinates were being received and thrown
 * away by the renderer.
 */
export function resolveJobBrief(booking, { originLat = null, originLng = null } = {}) {
    const b = booking || {};
    const phase = resolveJobPhase(b);
    const copy  = PHASE_COPY[phase] || PHASE_COPY[JOB_PHASE.CLOSED];
    const customer = resolveCustomer(b);

    const lat = Number(b.lat), lng = Number(b.lng);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
    const address = text(b.address);

    const photos = Array.isArray(b.photos)
        ? b.photos.filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
        : [];

    // Contact is withheld until the artisan has actually committed AND the visit
    // is funded. A dispatched candidate who has not accepted has no operational
    // need for the customer's phone number.
    const contactUnlocked = ![JOB_PHASE.REQUEST, JOB_PHASE.AWAITING_CALLOUT, JOB_PHASE.CLOSED]
        .includes(phase);

    return {
        bookingId: resolveBookingId(b),
        phase,
        phaseLabel: copy.label,
        phaseHint:  copy.hint,
        // 'Inspection' vs 'Work' — the same statuses recur in both cycles.
        cycle: copy.cycle,

        service: text(b.serviceType) || text(b.service) || text(b.category),
        // The customer's own words, in full. The card may clamp them visually,
        // but the complete text is always present in the DOM and expandable.
        problem: text(b.description),
        notes:   text(b.notes),

        customer: {
            name: customer.name,
            // null when withheld — the UI shows no contact affordance at all
            // rather than a dead button.
            phone: contactUnlocked ? customer.phone : null,
            contactUnlocked,
        },

        location: {
            address,
            hasCoords,
            lat: hasCoords ? lat : null,
            lng: hasCoords ? lng : null,
            // Navigation targets the CUSTOMER's booking coordinates. Falls back to
            // an address query only when there is no fix — never to a city centre.
            mapUrl: hasCoords
                ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
                : (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null),
            precision: hasCoords ? 'gps' : (address ? 'address-only' : 'none'),
        },

        distanceKm: hasCoords ? distanceKm(originLat, originLng, lat, lng) : null,

        compensation: resolveArtisanCompensation(b),

        photos,
        photoCount: photos.length,

        scheduledFor: text(b.scheduledFor),
        createdAt:    text(b.createdAt),
    };
}

// ── Quote decision ───────────────────────────────────────────────────────────

/**
 * What declining a quote ACTUALLY does at this point.
 *
 * quotes.js implements a single-revision rule: the first rejection sends the
 * booking back so the artisan can submit ONE revised quote; only the second is
 * final and cancels the job. The interface called both "Reject Quote", which
 * reads as terminal — so the customer who merely wanted the price adjusted had
 * to gamble on blowing up the whole job. Meanwhile the booking receipt promises
 * "Approve it, ask for one revision, or decline", a revision the UI never
 * offered. The capability was there; the wording denied it.
 */
export function resolveQuoteDecision(booking) {
    const revisions = Number(booking?.quoteRevisionCount || 0);
    const canRevise = revisions < 1;

    return canRevise ? {
        canRevise: true,
        label:  'Ask for a different price',
        title:  'Ask for a different price?',
        body:   'Your professional can send one revised quote. The job stays live and your visit fee stays credited.',
        confirm: 'Send back for one revision',
    } : {
        canRevise: false,
        label:  'Decline this quote',
        title:  'Decline and end this job?',
        // The consequence is stated plainly rather than buried in fine print.
        body:   'This was the revised quote, so declining ends the job. Your visit fee pays your professional for the inspection they already carried out.',
        confirm: 'Decline and end the job',
    };
}

// ── The journey ──────────────────────────────────────────────────────────────

/**
 * THE ONE LIFECYCLE MODEL both apps render.
 *
 * The backend state machine is correct and is not restated here — this is a
 * presentation projection over it. Six stages, because a customer can hold six
 * things in their head; the seventeen backend statuses map onto them.
 *
 * Every screen that shows "where am I" reads this, so the customer and the
 * artisan are looking at the same journey from two sides rather than at two
 * unrelated sets of screens.
 */
export const JOURNEY_STAGES = [
    { key: 'request',    customer: 'Request',      artisan: 'Request' },
    { key: 'pro',        customer: 'Professional', artisan: 'Accepted' },
    { key: 'inspection', customer: 'Inspection',   artisan: 'Inspection' },
    { key: 'quote',      customer: 'Quote',        artisan: 'Quote' },
    { key: 'work',       customer: 'Work',         artisan: 'Work' },
    { key: 'complete',   customer: 'Complete',     artisan: 'Paid' },
];

const PHASE_TO_STAGE = {
    [JOB_PHASE.REQUEST]:          0,
    [JOB_PHASE.AWAITING_CALLOUT]: 1,
    [JOB_PHASE.INSPECTION]:       2,
    [JOB_PHASE.QUOTING]:          3,
    [JOB_PHASE.AWAITING_QUOTE]:   3,
    [JOB_PHASE.WORK]:             4,
    [JOB_PHASE.AWAITING_CONFIRM]: 4,
    [JOB_PHASE.CLOSED]:           5,
};

/**
 * The three questions every screen must answer in seconds:
 * where am I, what just happened, what happens next.
 *
 * `action` is the SINGLE most important valid thing this audience can do now —
 * never a list of competing primaries, never an action the backend would reject.
 * `action: null` means "nothing to do", which is itself an answer and is far
 * calmer than an enabled button that does nothing.
 */
export function resolveJourney(booking, audience = 'customer') {
    const b     = booking || {};
    const phase = resolveJobPhase(b);
    const st    = norm(b.status);
    const m     = resolveMoney(b);
    const a     = resolveArtisan(b);
    const who   = a.name || 'your professional';
    const isCustomer = audience !== 'artisan';

    const stageIndex = PHASE_TO_STAGE[phase] ?? 0;
    const terminal   = ['completed', 'cancelled', 'rejected', 'unfulfilled'].includes(st);

    // ── Dead ends first: they are not points on the journey ──────────────────
    if (st === 'cancelled' || st === 'rejected') {
        return {
            stageIndex, terminal: true, tone: 'ended',
            here:   'Request closed',
            just:   text(b.cancellationReason) ||
                    (m.calloutSettled === 'refunded' ? 'Your callout fee was refunded to your wallet.' : 'This request was cancelled.'),
            next:   null,
            action: isCustomer ? { label: 'Start a new request', href: 'book-request.html' } : null,
        };
    }
    if (st === 'unfulfilled') {
        return {
            stageIndex, terminal: true, tone: 'ended',
            here: 'No professional available',
            just: 'Every professional nearby was busy. Nothing was charged.',
            next: 'You can try again — availability changes through the day.',
            action: isCustomer ? { label: 'Try again', href: 'book-request.html' } : null,
        };
    }

    const S = {};

    S[JOB_PHASE.REQUEST] = isCustomer ? {
        here: 'Finding your professional',
        just: 'Your problem, photos and location have been sent to verified professionals nearby.',
        // Truthful, not a countdown: the app does not know when someone will accept.
        next: 'We will notify you the moment one accepts. You can close the app.',
        action: { label: 'Cancel request', kind: 'ghost', op: 'cancel' },
        tone: 'waiting',
    } : {
        here: 'New request',
        just: 'A customer nearby needs this job.',
        next: 'Accept to take it, or decline so it goes to someone else.',
        action: { label: 'Accept', kind: 'primary', op: 'accept' },
        tone: 'action',
    };

    S[JOB_PHASE.AWAITING_CALLOUT] = isCustomer ? {
        here: `${who} accepted`,
        just: `${who} has accepted your request.`,
        next: 'Pay the visit fee to lock in the inspection. It comes off your final bill.',
        action: m.calloutFee !== null
            ? { label: `Pay visit fee · ${formatMoney(m.calloutFee)}`, kind: 'primary', op: 'payCallout' }
            : { label: 'Pay visit fee', kind: 'primary', op: 'payCallout' },
        tone: 'action',
    } : {
        here: 'Waiting for the customer',
        just: 'You accepted this job.',
        next: 'The customer is paying the visit fee. You will be notified when it clears.',
        action: null,
        tone: 'waiting',
    };

    S[JOB_PHASE.INSPECTION] = isCustomer ? {
        here: st === 'en_route' ? `${who} is on the way` : 'Inspection booked',
        just: 'Your visit fee is secured in escrow.',
        next: `${who} will assess the problem, then send you a fixed price.`,
        action: { label: 'Track', kind: 'secondary', op: 'track' },
        tone: 'live',
    } : {
        here: st === 'en_route' ? 'On your way' : 'Inspection visit',
        just: 'The visit fee is secured — you are paid for this trip.',
        next: 'Assess the problem on site, then complete the inspection.',
        action: st === 'inspection_scheduled'
            ? { label: 'Mark en route', kind: 'primary', op: 'enRoute' }
            : { label: 'Complete inspection', kind: 'primary', op: 'completeInspection' },
        tone: 'action',
    };

    S[JOB_PHASE.QUOTING] = isCustomer ? {
        here: 'Inspection complete',
        just: `${who} has assessed the problem.`,
        next: 'Your fixed quote is being prepared — we will notify you.',
        action: null,
        tone: 'waiting',
    } : {
        here: 'Quote needed',
        just: 'You completed the inspection.',
        next: 'Send the customer a fixed price for the work.',
        action: { label: 'Submit quote', kind: 'primary', op: 'submitQuote' },
        tone: 'action',
    };

    S[JOB_PHASE.AWAITING_QUOTE] = isCustomer ? {
        here: 'Your quote is ready',
        just: `${who} has sent a fixed price for the work.`,
        next: m.amountDue === 0
            ? 'Your visit fee covers it in full — approving takes nothing more.'
            : 'Review it, then approve or decline.',
        action: { label: 'Review quote', kind: 'primary', op: 'reviewQuote' },
        tone: 'action',
    } : {
        here: 'Quote sent',
        just: `You quoted ${formatMoney(m.jobQuote)}.`,
        next: 'Waiting for the customer to approve. You will be notified.',
        action: null,
        tone: 'waiting',
    };

    S[JOB_PHASE.WORK] = isCustomer ? {
        here: st === 'en_route' ? `${who} is on the way` : 'Work in progress',
        just: 'You approved the quote and the payment is held safely in escrow.',
        next: `${who} will carry out the work, then you confirm it is done.`,
        action: { label: 'Track', kind: 'secondary', op: 'track' },
        tone: 'live',
    } : {
        here: st === 'in_progress' ? 'Working' : 'Work approved',
        just: 'The customer approved your quote and the money is in escrow.',
        next: 'Do the job, then mark it done so the customer can release payment.',
        action: st === 'accepted'    ? { label: 'Mark en route',  kind: 'primary', op: 'enRoute' }
              : st === 'en_route'    ? { label: 'Mark arrived',   kind: 'primary', op: 'arrived' }
              :                        { label: 'Mark job done',  kind: 'primary', op: 'markDone' },
        tone: 'action',
    };

    S[JOB_PHASE.AWAITING_CONFIRM] = isCustomer ? {
        here: 'Work finished',
        just: `${who} has marked the job as done.`,
        next: 'Confirm it is complete — this releases the payment held in escrow.',
        action: { label: 'Confirm work is complete', kind: 'primary', op: 'confirmDone' },
        tone: 'action',
    } : {
        here: 'Waiting for confirmation',
        just: 'You marked the job done.',
        next: 'The customer confirms, then your earnings are released.',
        action: null,
        tone: 'waiting',
    };

    S[JOB_PHASE.CLOSED] = isCustomer ? {
        here: 'Completed',
        just: 'You confirmed the work and the payment was released.',
        next: null,
        action: { label: 'View receipt', kind: 'secondary', op: 'receipt' },
        tone: 'done',
    } : {
        here: 'Completed',
        just: 'The customer confirmed the job.',
        next: null,
        action: { label: 'View earnings', kind: 'secondary', op: 'earnings' },
        tone: 'done',
    };

    return { stageIndex, terminal, ...(S[phase] || S[JOB_PHASE.REQUEST]) };
}

/** Stage list with per-stage state, for a progress rail. */
export function journeyStages(booking, audience = 'customer') {
    const { stageIndex, terminal } = resolveJourney(booking, audience);
    return JOURNEY_STAGES.map((s, i) => ({
        key:   s.key,
        label: audience === 'artisan' ? s.artisan : s.customer,
        state: i < stageIndex ? 'done' : i === stageIndex ? (terminal ? 'done' : 'current') : 'todo',
    }));
}

// ── Load-state machine ───────────────────────────────────────────────────────

/**
 * The four states every booking-bound screen must distinguish. Collapsing
 * LOADING into NOT_FOUND is what told a customer with a funded escrow booking
 * that they had "No Active Booking".
 */
export const LOAD_STATE = {
    LOADING:   'loading',
    FOUND:     'found',
    NOT_FOUND: 'not_found',
    ERROR:     'error',
};

/**
 * Classify a subscription/lookup result.
 *
 * `snapshotReceived` is the critical input: absence of data is only evidence of
 * absence once the authoritative backend has actually answered.
 */
export function classifyLookup({ snapshotReceived = false, exists = false, error = null } = {}) {
    if (error) return LOAD_STATE.ERROR;
    if (!snapshotReceived) return LOAD_STATE.LOADING;
    return exists ? LOAD_STATE.FOUND : LOAD_STATE.NOT_FOUND;
}

// ── Reputation ───────────────────────────────────────────────────────────────

/**
 * An artisan's rating, with "never been rated" kept distinct from "rated zero".
 *
 * Production shipped `Number(a.rating || 0).toFixed(1)` on every discovery
 * surface, so the one artisan in the database — who has completed 7 jobs and
 * received no reviews at all — was advertised to customers as **0.0 ★**. In a
 * marketplace where the rating is the only signal a customer has before letting
 * a stranger into their home, "0.0" is not a neutral placeholder: it reads as
 * seven customers who all rated them the lowest possible score. The product was
 * actively defaming its own supply.
 *
 * These are different facts and must render differently:
 *   • reviewCount 0/null  → no reviews yet   (no score may be shown)
 *   • reviewCount > 0     → the real average
 *
 * reviewCount is normalised through money()-style null handling because the
 * field is genuinely `null` on existing artisan documents (it was never
 * initialised at signup), and `null` does not trigger a JS default parameter.
 */
export function resolveRating(artisanLike) {
    const a = artisanLike || {};
    const rawCount = a.reviewCount;
    const count = (rawCount == null || rawCount === '' || isNaN(Number(rawCount)))
        ? 0 : Math.max(0, Math.floor(Number(rawCount)));

    if (count === 0) {
        return {
            hasReviews:  false,
            rating:      null,          // never 0 — there is no score to report
            reviewCount: 0,
            label:       'No reviews yet',
            short:       'New',
        };
    }

    const rawRating = Number(a.rating);
    // A positive review count with an unusable score is a data fault, not a
    // zero-star artisan. Say nothing rather than something false.
    if (!Number.isFinite(rawRating) || rawRating <= 0) {
        return {
            hasReviews:  false,
            rating:      null,
            reviewCount: count,
            label:       'No rating available',
            short:       '—',
        };
    }

    const rating = Math.round(rawRating * 10) / 10;
    return {
        hasReviews:  true,
        rating,
        reviewCount: count,
        label:       `${rating.toFixed(1)} (${count} review${count === 1 ? '' : 's'})`,
        short:       rating.toFixed(1),
    };
}

/**
 * Whether this booking can still be reviewed, and why not when it cannot.
 *
 * Mirrors the Firestore rule exactly (customer party, status completed, no
 * existing rating) so the interface never offers an action the server will
 * reject, and never hides one it would accept.
 */
export function resolveReviewEligibility(booking, viewerUid) {
    const b = booking || {};
    if (!b.customerId || !viewerUid || b.customerId !== viewerUid) {
        return { canReview: false, reason: 'not_customer' };
    }
    if (String(b.status || '').toLowerCase() !== 'completed') {
        return { canReview: false, reason: 'not_completed' };
    }
    if (b.rating != null) {
        return { canReview: false, reason: 'already_reviewed', rating: Number(b.rating) };
    }
    return { canReview: true, reason: null };
}
