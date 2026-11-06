/**
 * shared/js/domain/artisanJobs.js — the artisan's Jobs: where each booking
 * belongs and what its row says (Phase 3).
 *
 * Pure: no DOM, no Firebase, clock passed in. No lifecycle of its own:
 *   where a booking belongs   artisanToday.placeJob (the same answer Today uses)
 *   its status and next step  bookingTruth.resolveJourney (only what the rules accept)
 *   what may be shown         bookingTruth.resolveJobBrief (name and address only once disclosed)
 *   how it ended              bookingTruth.resolveClosure
 * so a booking reads the same in Jobs, on Today and on its own screen.
 *
 * The views:
 *   current   needs you · waiting on the customer · on hold (a dispute)
 *   upcoming  booked slots that have not opened yet (soonest first)
 *   history   closed bookings, most recent first: completed, cancelled,
 *             closed automatically, disputes resolved
 */
import { placeJob, byJobRank } from './artisanToday.js';
import { resolveJobBrief, resolveClosure, formatDistance } from './bookingTruth.js';

const norm = (v) => String(v ?? '').trim().toLowerCase();

export const JOB_VIEWS = Object.freeze(['current', 'upcoming', 'history']);
export const HISTORY_FILTERS = Object.freeze(['all', 'completed', 'cancelled']);

/** The statuses a history page asks for (closed, and the artisan's). */
export const HISTORY_STATUSES = Object.freeze(['completed', 'cancelled', 'resolved']);
/** The statuses the live list asks for — the same set Today subscribes to. */
export const ACTIVE_STATUSES = Object.freeze(['accepted', 'en_route', 'in_progress', 'awaiting',
    'inspection_scheduled', 'inspection_done', 'quoted', 'disputed']);

const ms = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'object' && Number.isFinite(Number(v.seconds))) return Number(v.seconds) * 1000;
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : null;
};
const recent = (a, b) => (ms(b.booking.updatedAt) ?? 0) - (ms(a.booking.updatedAt) ?? 0);

/** The day a closed booking ended, in Accra. */
export function closedOn(booking) {
    const b = booking || {};
    const t = ms(b.completedAt) ?? ms(b.cancelledAt) ?? ms(b.resolvedAt) ?? ms(b.updatedAt);
    if (t === null) return null;
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Accra' });
}

/**
 * Sort bookings into the Jobs views.
 * @param {object[]} bookings  the artisan's bookings (data + id): the live list and any history pages
 * @param {number} [nowMs]
 */
export function groupJobs(bookings = [], nowMs = Date.now()) {
    const seen = new Set();
    const placed = [];
    for (const b of bookings) {
        if (!b || !b.id || seen.has(b.id)) continue;   // a booking in both the live list and a history page counts once
        seen.add(b.id);
        placed.push({ booking: b, ...placeJob(b, nowMs) });
    }
    const disputed = (p) => norm(p.booking.status) === 'disputed';
    const needsYou = placed.filter((p) => p.place === 'yours').sort((a, b) => byJobRank(a, b) || recent(a, b));
    const waiting  = placed.filter((p) => p.place === 'waiting' && !disputed(p)).sort(recent);
    const onHold   = placed.filter((p) => p.place === 'waiting' && disputed(p)).sort(recent);
    const upcoming = placed.filter((p) => p.place === 'upcoming')
        .sort((a, b) => (a.schedule.startMs ?? Infinity) - (b.schedule.startMs ?? Infinity));
    const history  = placed.filter((p) => p.place === 'closed').sort(recent);
    return { needsYou, waiting, onHold, upcoming, history,
             counts: { current: needsYou.length + waiting.length + onHold.length, upcoming: upcoming.length } };
}

/** History, filtered: completed · cancelled (by anyone, or closed automatically) · all. */
export function filterHistory(history, filter = 'all') {
    if (filter === 'completed') return history.filter((p) => norm(p.booking.status) === 'completed');
    if (filter === 'cancelled') return history.filter((p) => norm(p.booking.status) === 'cancelled');
    return history;
}

/**
 * One row: what an artisan needs to recognise the job and know what is next.
 * @param {{ booking: object, place: string, journey: object, schedule: object }} p  a groupJobs entry
 * @param {{ originLat?: number|null, originLng?: number|null }} [origin]  the artisan's own position, for distance
 */
export function jobRow(p, origin = {}) {
    const b = p.booking;
    const brief = resolveJobBrief(b, { originLat: origin.originLat ?? null, originLng: origin.originLng ?? null });
    const closed = p.place === 'closed';
    const closure = closed ? resolveClosure(b) : null;
    const distance = formatDistance(brief.distanceKm);
    return {
        id: b.id,
        service: brief.service || 'Job',
        // Named only once disclosed (resolveJobBrief withholds it before acceptance).
        customer: brief.customer.name,
        status: closure ? closure.label : p.journey.here,
        tone: closure ? (closure.kind === 'completed' ? 'ok' : 'ended') : (norm(b.status) === 'disputed' ? 'bad' : p.journey.tone),
        when: closed ? closedOn(b) : (p.schedule.scheduled ? p.schedule.label : null),
        // Where, as disclosed: the address while the booking is live, never on history
        // (it is removed 14 days after closing, decision Q6), distance when known.
        where: closed ? null : (distance || brief.location.address || null),
        next: p.place === 'yours' && p.journey.action ? p.journey.action.label : null,
        detail: closed ? (closure && closure.sentence) || null : null,
        place: p.place,
    };
}
