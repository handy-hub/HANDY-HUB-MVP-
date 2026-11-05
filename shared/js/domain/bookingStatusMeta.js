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
 *
 * TIME IS NOT STATUS
 * ──────────────────
 * A booking's status says what has happened. It does not say WHEN the job is —
 * that lives in shared/js/domain/bookingSchedule.js, deliberately apart, because
 * an appointment is orthogonal to the lifecycle (a scheduled inspection is still
 * an inspection). describe() and getAllowedActions() therefore take an optional
 * `schedule` — the result of resolveSchedule() — rather than importing it, which
 * keeps this module's no-imports promise. Omit it and every booking reads as
 * immediate, which is what every booking written before scheduling existed was.
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
    // Written by resolveDispute (functions/disputes.js) for every outcome:
    // release, full refund or a partial split. The escrow says which.
    'resolved',
];

// ── Tab / group membership ───────────────────────────────────────────────────
// The four top-level buckets every list view uses. `disputed` groups with
// ongoing (money is frozen but the job is still live pending admin review).
export const TAB_STATUSES = {
    upcoming:  ['pending', 'dispatching', 'searching', 'dispatched', 'assigned'],
    ongoing:   ['accepted', 'inspection_scheduled', 'inspection_done', 'quoted',
                'en_route', 'in_progress', 'awaiting', 'disputed'],
    // A resolved dispute is closed: it was a job that reached settlement.
    completed: ['completed', 'resolved'],
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
    // Where the money went is the escrow's to say (bookingTruth), not this label's.
    resolved:     { label: 'Resolved',       group: 'completed', tone: 'completed',
                    description: 'Our team resolved the dispute on this booking.' },
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
        resolved:     { label: 'Resolved',     description: 'The dispute was resolved. Your wallet shows the outcome.' },
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
export function describe(booking, audience = 'customer', opts = {}) {
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

    // ── A booked appointment changes what "accepted" MEANS ───────────────────
    //
    // The artisan copy for `accepted` was "Customer is waiting — head to their
    // location", and for `inspection_scheduled` "head over and assess the
    // problem". Both are true of an immediate booking and false of an
    // appointment: nobody is waiting on Monday for a Saturday visit, and an
    // artisan told to head over is being told to break the promise they made.
    //
    // The status has not changed; its meaning has. That is exactly the class of
    // context this function exists to resolve — the same reason `accepted` on an
    // unpaid inspection already reads "Pay visit fee" above.
    const schedule = opts.schedule || null;
    const awaitingSlot = schedule && schedule.scheduled && schedule.isDue === false;

    if (awaitingSlot && ['accepted', 'inspection_scheduled'].includes(status) &&
        !(isInspection && status === 'accepted' && !booking?.calloutPaid)) {
        if (audience === 'artisan') {
            label = 'Booked';
            description = `You committed to this visit for ${schedule.label}. Nothing to do until then.`;
        } else {
            label = 'Visit booked';
            description = `Your professional is booked for ${schedule.label}.`;
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
        // True when the booking is committed but the slot has not arrived. Lets a
        // list view render "waiting for Saturday" as the calm state it is rather
        // than as an action the reader is failing to take.
        awaitingSlot: !!awaitingSlot,
    };
}

/**
 * Actions available to a given audience for a booking, in render order. Each is
 * { id, label, kind }. `kind` is 'primary' | 'default' | 'danger' so the UI can
 * style consistently. This centralises "which button shows when" so buttons,
 * like labels, derive from the single definition.
 */
export function getAllowedActions(booking, audience = 'customer', opts = {}) {
    const status = norm(booking?.status);
    const isInspection = norm(booking?.track) === 'inspection';
    const out = [];

    // ── The appointment gate ─────────────────────────────────────────────────
    // `schedule` is a resolveSchedule() result. Absent, or unscheduled, means
    // "now" and nothing below changes. Scheduled-but-not-yet-due suppresses the
    // travel/start controls: an artisan who committed to Saturday should not be
    // shown "Mark En Route" on Monday, because firestore.rules will refuse the
    // write and a button that cannot work is worse than no button.
    const schedule = opts.schedule || null;
    const dueNow   = !schedule || !schedule.scheduled || schedule.isDue === true;

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
        // Inspection track, before the quote is approved: one step at a time, in
        // the order the server enforces (see artisanInspectionStep).
        const step = artisanInspectionStep(booking, { schedule });
        if (step && step.id !== 'await_callout' && step.id !== 'await_decision') {
            out.push(step.blocked
                ? { id: step.id, label: step.label, kind: 'info', disabled: true }
                : { id: step.id, label: step.label, kind: 'primary' });
        }
        if (!isInspection || booking?.quoteApproved) {
            if (status === 'accepted') {
                // Off the inspection track an accepted job has no approved quote
                // until the artisan sends one, and the rules refuse travel before
                // it (see needsQuoteBeforeTravel).
                if (needsQuoteBeforeTravel(booking)) out.push({ id: 'submit_quote', label: 'Submit Quote', kind: 'primary' });
                else if (dueNow) out.push({ id: 'en_route', label: 'Mark En Route', kind: 'primary' });
                else out.push({ id: 'scheduled', label: `Booked · ${schedule.label}`, kind: 'info', disabled: true });
            }
            if (status === 'en_route') out.push({ id: 'arrived', label: 'Mark Arrived', kind: 'primary' });
            if (status === 'in_progress') out.push({ id: 'job_done', label: 'Mark Job Done', kind: 'primary' });
        }
    }
    return out;
}

/**
 * The artisan's next step on the inspection track, before a quote is approved.
 *
 * THE rule for which inspection control an artisan is offered. getAllowedActions,
 * the jobs list and the dashboard all read it, and functions/pricing.js
 * (inspectionCompletionBlocker) enforces the same order on the server:
 *
 *   accepted, callout unpaid → wait for the customer to pay
 *   inspection_scheduled     → set out — only once the booked window opens
 *   en_route                 → mark arrived — never clock-gated
 *   in_progress              → complete the inspection — only after arrival
 *   inspection_done          → submit the quote
 *   quoted                   → wait for the customer's decision
 *
 * The callout fee pays for a visit, and completing the inspection is what lets
 * it reach the artisan, so "Complete Inspection" is never offered before
 * arrival has been recorded.
 *
 * @param {object} booking
 * @param {{schedule?: object}} [opts]  a resolveSchedule() result
 * @returns {{id: string, label: string, blocked?: boolean}|null}  null off the
 *          inspection track, or once the quote is approved (the work phase uses
 *          the ordinary steps)
 */
export function artisanInspectionStep(booking, opts = {}) {
    const b = booking || {};
    if (norm(b.track) !== 'inspection' || b.quoteApproved === true) return null;
    const schedule = opts.schedule || null;
    const dueNow   = !schedule || !schedule.scheduled || schedule.isDue === true;
    switch (norm(b.status)) {
        case 'accepted':
            return b.calloutPaid ? null : { id: 'await_callout', label: 'Awaiting callout fee…', blocked: true };
        case 'inspection_scheduled':
            return dueNow
                ? { id: 'en_route', label: 'Mark En Route' }
                : { id: 'scheduled', label: `Booked · ${schedule.label}`, blocked: true };
        case 'en_route':        return { id: 'arrived', label: 'Mark Arrived' };
        case 'in_progress':     return { id: 'complete_inspection', label: 'Complete Inspection' };
        case 'inspection_done': return { id: 'submit_quote', label: 'Submit Quote' };
        case 'quoted':          return { id: 'await_decision', label: 'Waiting for customer decision…', blocked: true };
        default:                return null;
    }
}

/**
 * Must the artisan send a quote before they may set out?
 *
 * firestore.rules lets an artisan move accepted → en_route only when the booking
 * carries an approved quote (the inspection track's pre-quote visit goes
 * inspection_scheduled → en_route instead). Off the inspection track — emergency
 * and standard bookings — nothing approves a quote until the artisan submits one,
 * so "Mark En Route" on an accepted, unquoted job was a button the rules always
 * refused (Phase 0 WF-02). This is the rule as written; whether emergencies
 * SHOULD travel before quoting is a business decision this function does not make.
 *
 * @param {object} booking
 * @returns {boolean}
 */
export function needsQuoteBeforeTravel(booking) {
    const b = booking || {};
    return norm(b.status) === 'accepted' && norm(b.track) !== 'inspection' && b.quoteApproved !== true;
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
