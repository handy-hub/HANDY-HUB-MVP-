/**
 * bookingStatusMeta.js — THE single source of truth for booking status semantics.
 *
 * Every surface that renders, groups, routes, or gates a booking by status —
 * customer app, artisan app, admin dashboard — imports from here. Before this
 * module the vocabulary was duplicated across six hand-rolled maps
 * (bookingStatusMeta customer map, artisan dashboard/jobs/bookings maps, admin
 * KPIs, plus VALID_STATUSES) that had already drifted: inspection statuses were
 * missing from some, `disputed` from others, and the same status rendered with
 * different labels and different tab groupings depending on the page. That drift
 * is what let internal states like "inspection_scheduled" leak to users as raw
 * snake_case text.
 *
 * DESIGN — context-aware, audience-aware
 * ──────────────────────────────────────
 * A booking's meaning is not the status string alone. The SAME status means
 * different things depending on:
 *   • track          — 'inspection' vs legacy/standard/emergency
 *   • quoteApproved   — an inspection booking re-enters normal execution after
 *                       the job quote is approved, so `en_route` before approval
 *                       means "travelling to inspect" and after means "travelling
 *                       to do the job"
 *   • audience        — `quoted` is "Quote ready" to the customer (their action)
 *                       but "Quote sent — awaiting decision" to the artisan
 *
 * So the primary API is describe(booking, audience) → a fully resolved view.
 * The legacy exports (getStatusMeta/getStatusGroup/getActiveProgress/
 * isCancellable) are preserved as thin wrappers so existing callers keep working.
 *
 * This module has NO imports so it evaluates in every browser context and can be
 * consumed by any of the three apps. Cloud Functions (CommonJS) use inline status
 * strings; the shared vocabulary here is mirrored by a CI check (see
 * scripts/check-status-vocab.cjs) rather than a runtime import, since Firestore
 * Rules and CFs cannot import an ES module.
 */

// ── Canonical vocabulary ─────────────────────────────────────────────────────
// The complete, ordered set of booking statuses. This IS the vocabulary;
// bookingRepository.VALID_STATUSES derives from it.
export const BOOKING_STATUSES = [
    'pending', 'dispatching', 'searching', 'dispatched', 'assigned',
    'accepted', 'rejected',
    'inspection_scheduled', 'inspection_done', 'quoted',
    'en_route', 'in_progress', 'awaiting',
    'completed', 'cancelled', 'unfulfilled', 'disputed',
];

// ── Tab / group membership ───────────────────────────────────────────────────
// The four top-level buckets every list view uses. `disputed` groups with
// ongoing (money is frozen but the job is still live pending admin review).
export const TAB_STATUSES = {
    upcoming:  ['pending', 'dispatching', 'searching', 'dispatched', 'assigned'],
    ongoing:   ['accepted', 'inspection_scheduled', 'inspection_done', 'quoted',
                'en_route', 'in_progress', 'awaiting', 'disputed'],
    completed: ['completed'],
    cancelled: ['cancelled', 'rejected', 'unfulfilled'],
};

// ── Base status metadata ─────────────────────────────────────────────────────
// `group` = which tab bucket. `tone` = a semantic key mapping to existing pill
// CSS (pill-${tone}) and driving the customer's bk-status-${group} classes.
// `label`/`description` are the DEFAULT (customer-facing) copy; per-audience and
// per-context overrides live in describe() below.
const BASE = {
    pending:      { label: 'Pending',        group: 'upcoming',  tone: 'pending',
                    description: 'Finding a professional for you.' },
    dispatching:  { label: 'Finding a pro',  group: 'upcoming',  tone: 'pending',
                    description: 'Matching you with a nearby professional.' },
    searching:    { label: 'Searching',      group: 'upcoming',  tone: 'pending',
                    description: 'Searching for an available professional.' },
    dispatched:   { label: 'Requesting',     group: 'upcoming',  tone: 'pending',
                    description: 'A professional has been asked to accept.' },
    assigned:     { label: 'Assigned',       group: 'upcoming',  tone: 'pending',
                    description: 'A professional has been assigned.' },
    accepted:     { label: 'Accepted',       group: 'ongoing',   tone: 'accepted',
                    description: 'A professional accepted your booking.' },
    rejected:     { label: 'Declined',       group: 'cancelled', tone: 'rejected',
                    description: 'The professional could not take this booking.' },
    inspection_scheduled: { label: 'Inspection booked', group: 'ongoing', tone: 'accepted',
                    description: 'Your callout fee is secured — the pro will come to assess the problem.' },
    inspection_done: { label: 'Inspected',   group: 'ongoing',   tone: 'in_progress',
                    description: 'The problem has been assessed — your quote is on the way.' },
    quoted:       { label: 'Quote ready',    group: 'ongoing',   tone: 'quoted',
                    description: 'Review the quote to approve or request one change.' },
    en_route:     { label: 'On the way',     group: 'ongoing',   tone: 'en_route',
                    description: 'Your professional is heading to you.' },
    in_progress:  { label: 'In progress',    group: 'ongoing',   tone: 'in_progress',
                    description: 'The job is underway.' },
    awaiting:     { label: 'Confirm done',   group: 'ongoing',   tone: 'awaiting',
                    description: 'Confirm the job is complete to release payment.' },
    completed:    { label: 'Completed',      group: 'completed', tone: 'completed',
                    description: 'This booking is complete.' },
    cancelled:    { label: 'Cancelled',      group: 'cancelled', tone: 'cancelled',
                    description: 'This booking was cancelled.' },
    unfulfilled:  { label: 'Unmatched',      group: 'cancelled', tone: 'cancelled',
                    description: 'No professional was available. Nothing was charged.' },
    disputed:     { label: 'In dispute',     group: 'ongoing',   tone: 'awaiting',
                    description: 'A dispute is under review by our team.' },
};

// Per-audience overrides. Only the statuses where the artisan/admin view differs
// from the default customer copy are listed; everything else falls back to BASE.
const AUDIENCE_OVERRIDE = {
    artisan: {
        pending:      { label: 'New request',  description: 'A customer is waiting — accept to take the job.' },
        accepted:     { label: 'Accepted',     description: 'Customer is waiting — head to their location.' },
        inspection_scheduled: { label: 'Inspection booked', description: 'Callout fee secured — head over and assess the problem.' },
        inspection_done: { label: 'Inspected', description: 'Submit your quote so the customer can approve.' },
        quoted:       { label: 'Quote sent',   description: 'Waiting for the customer to approve your quote.' },
        awaiting:     { label: 'Awaiting',     description: 'Waiting for the customer to confirm completion.' },
        en_route:     { label: 'En route',     description: 'On your way — mark arrived when you get there.' },
        in_progress:  { label: 'In progress',  description: 'Job in progress — mark done when finished.' },
        completed:    { label: 'Completed',    description: 'You completed this job. Earnings credited.' },
    },
    admin: {
        pending:      { label: 'Pending' },
        dispatching:  { label: 'Dispatching' },
        dispatched:   { label: 'Waiting' },
        quoted:       { label: 'Quoted' },
        awaiting:     { label: 'Awaiting' },
        disputed:     { label: 'Disputed' },
    },
};

// ── Progress (ongoing statuses only) ─────────────────────────────────────────
// pct + phase label for the active-job progress bar. Inspection-track and legacy
// share this — the phase differs but the bar geometry is the same.
export const ACTIVE_PROGRESS = {
    accepted:             { pct: 15, label: 'Booking Accepted'      },
    inspection_scheduled: { pct: 30, label: 'Inspection Booked'     },
    en_route:             { pct: 40, label: 'On the Way'            },
    in_progress:          { pct: 60, label: 'Inspecting / Working'  },
    inspection_done:      { pct: 65, label: 'Inspection Done'       },
    quoted:               { pct: 75, label: 'Quote Ready'           },
    awaiting:             { pct: 90, label: 'Awaiting Confirmation' },
    disputed:             { pct: 50, label: 'In Dispute'            },
};

function norm(v) { return String(v == null ? '' : v).toLowerCase(); }

/**
 * Fully resolve a booking's status for a given audience and context.
 * @param {object} booking { status, track, quoteApproved, calloutPaid }
 * @param {'customer'|'artisan'|'admin'} [audience='customer']
 * @returns {{ key, label, description, group, tone, isTerminal, cancellable }}
 */
export function describe(booking, audience = 'customer') {
    const status = norm(booking?.status);
    const base   = BASE[status] || { label: booking?.status || 'Pending', group: 'upcoming', tone: 'pending', description: '' };
    const over   = (AUDIENCE_OVERRIDE[audience] || {})[status] || {};

    let label       = over.label       ?? base.label;
    let description = over.description  ?? base.description;
    const group     = base.group;
    const tone      = base.tone;

    // ── Context overrides that no static map can express ──────────────────────
    const isInspection = norm(booking?.track) === 'inspection';

    // An accepted inspection booking whose callout is unpaid is the customer's
    // single most urgent action (F2). Surface it as such — not a passive "Accepted".
    if (isInspection && status === 'accepted' && !booking?.quoteApproved && !booking?.calloutPaid) {
        if (audience === 'customer') {
            label = 'Pay visit fee';
            description = 'A professional accepted — pay the callout fee to lock it in.';
        } else if (audience === 'artisan') {
            label = 'Awaiting payment';
            description = 'Waiting for the customer to pay the callout fee.';
        }
    }

    return {
        key:        status,
        label,
        description,
        group,
        tone,
        isTerminal: TAB_STATUSES.completed.includes(status) || TAB_STATUSES.cancelled.includes(status),
        cancellable: group === 'upcoming' || (isInspection && ['accepted', 'inspection_scheduled', 'inspection_done', 'quoted'].includes(status)),
    };
}

/**
 * Actions available to a given audience for a booking, in render order. Each is
 * { id, label, kind }. `kind` is 'primary' | 'default' | 'danger' so the UI can
 * style consistently. This centralises "which button shows when" so buttons,
 * like labels, derive from the single definition.
 */
export function getAllowedActions(booking, audience = 'customer') {
    const status = norm(booking?.status);
    const isInspection = norm(booking?.track) === 'inspection';
    const out = [];

    if (audience === 'customer') {
        if (isInspection && status === 'accepted' && !booking?.calloutPaid) {
            out.push({ id: 'pay_callout', label: 'Pay callout fee', kind: 'primary' });
        }
        if (status === 'quoted') out.push({ id: 'review_quote', label: 'Review quote', kind: 'primary' });
        if (status === 'awaiting') out.push({ id: 'confirm_done', label: 'Confirm done', kind: 'primary' });
        if (['en_route', 'in_progress', 'inspection_scheduled'].includes(status)) {
            out.push({ id: 'track', label: 'Track', kind: 'default' });
        }
        if (describe(booking, 'customer').cancellable) {
            out.push({ id: 'cancel', label: 'Cancel', kind: 'danger' });
        }
    } else if (audience === 'artisan') {
        if (['pending', 'dispatched', 'assigned'].includes(status)) {
            out.push({ id: 'accept', label: 'Accept', kind: 'primary' });
            out.push({ id: 'decline', label: 'Decline', kind: 'default' });
        }
        if (isInspection && status === 'inspection_scheduled') {
            out.push({ id: 'en_route', label: 'Mark En Route', kind: 'primary' });
            out.push({ id: 'complete_inspection', label: 'Complete Inspection', kind: 'primary' });
        }
        if (isInspection && ['en_route', 'in_progress'].includes(status) && !booking?.quoteApproved) {
            out.push({ id: 'complete_inspection', label: 'Complete Inspection', kind: 'primary' });
        }
        if (isInspection && status === 'inspection_done') {
            out.push({ id: 'submit_quote', label: 'Submit Quote', kind: 'primary' });
        }
        if (!isInspection || booking?.quoteApproved) {
            if (status === 'accepted') out.push({ id: 'en_route', label: 'Mark En Route', kind: 'primary' });
            if (status === 'en_route') out.push({ id: 'arrived', label: 'Mark Arrived', kind: 'primary' });
            if (status === 'in_progress') out.push({ id: 'job_done', label: 'Mark Job Done', kind: 'primary' });
        }
    }
    return out;
}

// ── Legacy-compatible wrappers (existing callers) ─────────────────────────────

/** Returns { label, group } — customer audience. Back-compat for booking.html. */
export function getStatusMeta(status) {
    const d = describe({ status }, 'customer');
    return { label: d.label, group: d.group, tone: d.tone };
}

/** Returns the tab/group name a status belongs to. */
export function getStatusGroup(status) {
    return (BASE[norm(status)] || { group: 'upcoming' }).group;
}

/** Returns { pct, label } progress info for an ongoing status. */
export function getActiveProgress(status) {
    return ACTIVE_PROGRESS[norm(status)] || { pct: 10, label: 'Processing' };
}

/**
 * Whether a booking can be cancelled from a swipe/list affordance.
 * Track-aware: pass the full booking for correct inspection-track handling;
 * a bare status keeps the old "upcoming-only" behaviour for legacy callers.
 */
export function isCancellable(statusOrBooking) {
    if (statusOrBooking && typeof statusOrBooking === 'object') {
        return describe(statusOrBooking, 'customer').cancellable;
    }
    return getStatusGroup(statusOrBooking) === 'upcoming';
}
