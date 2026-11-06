/**
 * shared/js/domain/artisanToday.js — what the artisan's Today screen shows, and
 * how an offer reads (Phase 2).
 *
 * Pure: no DOM, no Firebase. Every fact comes from a server-written field, and
 * every rule comes from the modules that already own it:
 *   offers     jobOffers.offerState (expiresAtMs is the only clock)
 *   journey    bookingTruth.resolveJourney (the action the rules accept)
 *   schedule   bookingSchedule.resolveSchedule
 *   account    availability.availabilityBlocker / storedAvailability
 *
 * Today shows ONE operational state at a time, in this order:
 *   1. an answerable offer        (it expires in minutes)
 *   2. a job that needs the artisan now
 *   3. the availability state     (offline / online / cannot go online)
 * Jobs waiting on the customer and future bookings stay listed, never taking over.
 *
 * Offers keep arriving while the artisan is on a job (decision Q3, 2026-11-06):
 * the offer state then carries `alsoOnJob`, so the screen can say so.
 */
import { offerState, offerDeadlineMs } from './jobOffers.js';
import { resolveJourney, serviceLabel, formatMoney, formatDistance } from './bookingTruth.js';
import { resolveSchedule } from './bookingSchedule.js';
import { availabilityBlocker, storedAvailability } from './availability.js';

const norm = (v) => String(v ?? '').trim().toLowerCase();
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const OFFER_KIND = Object.freeze({
    EMERGENCY:  'emergency',
    SCHEDULED:  'scheduled',
    STANDARD:   'standard',
});

export const TODAY_MODE = Object.freeze({
    UNKNOWN: 'unknown',   // the profile has not loaded
    LOCKED:  'locked',    // cannot go online (verification, suspension)
    OFFER:   'offer',
    JOB:     'job',
    ONLINE:  'online',    // available, waiting for offers
    OFFLINE: 'offline',
});

function isEmergency(o) {
    return norm(o.track) === 'emergency' || o.isEmergency === true ||
           norm(o.type) === 'emergency' || norm(o.bookingType) === 'emergency';
}

/** Emergency › scheduled › standard. A customer-chosen offer is any of them (`chosenByCustomer`). */
export function offerKind(offer) {
    const o = offer || {};
    if (isEmergency(o)) return OFFER_KIND.EMERGENCY;
    if (resolveSchedule(o).scheduled) return OFFER_KIND.SCHEDULED;
    return OFFER_KIND.STANDARD;
}

/**
 * An offer, as the artisan reads it before deciding. From the offer summary
 * (job_offers/{bookingId}) only: no address, no exact position, no name.
 *
 * The countdown is the server's: secondsLeft from expiresAtMs, and the bar's
 * whole from offeredAt → expiresAtMs. A customer-chosen offer has no deadline
 * and shows none. Nothing here is computed about money: the visit fee is the
 * server's calloutFee, as charged, labelled as such.
 *
 * @param {object} offer   job_offers/{bookingId} data (+ id)
 * @param {number} [nowMs]
 */
export function offerView(offer, nowMs = Date.now()) {
    const o = offer || {};
    const kind = offerKind(o);
    const st = offerState(o, nowMs);
    const offeredAtMs = offerDeadlineMs(o.offeredAt);
    const appt = resolveSchedule(o, nowMs);
    const fee = Number(o.calloutFee);
    const km = Number(o.distanceKm);
    const photos = Array.isArray(o.photos) ? o.photos.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)) : [];

    return {
        id: o.bookingId || o.id || null,
        kind,
        chosenByCustomer: o.prematched === true,
        service: serviceLabel(o.serviceType) || serviceLabel(o.service) || serviceLabel(o.category) || 'Job request',
        heading: kind === OFFER_KIND.EMERGENCY ? 'Emergency request'
               : o.prematched === true        ? 'A customer chose you'
               : kind === OFFER_KIND.SCHEDULED ? 'Booking request'
               :                                  'New job request',
        when: kind === OFFER_KIND.EMERGENCY ? 'Now'
            : appt.scheduled ? appt.label
            : 'As soon as possible',
        // Accepting a slot is a promise about that day (bookingTruth's REQUEST copy).
        commitment: kind === OFFER_KIND.SCHEDULED ? `Accepting commits you to arriving ${appt.label}.` : null,
        distance: o.distanceKm !== null && o.distanceKm !== undefined && Number.isFinite(km) ? formatDistance(km) : null,
        visitFee: Number.isFinite(fee) && fee > 0 ? formatMoney(fee) : null,
        travelIncluded: Number(o.travelFee) > 0,
        problem: text(o.description),
        photos,
        countdown: st.expiresAtMs === null ? null : {
            expiresAtMs: st.expiresAtMs,
            secondsLeft: st.secondsLeft,
            totalMs: offeredAtMs !== null && st.expiresAtMs > offeredAtMs ? st.expiresAtMs - offeredAtMs : null,
        },
        answerable: !st.expired,
    };
}

// Which job needs the artisan most: on site, then travelling, then the rest.
const JOB_RANK = { in_progress: 0, en_route: 1, inspection_done: 2, accepted: 3, inspection_scheduled: 4 };

/**
 * One job, placed: does it need the artisan now ('yours'), is it a booked slot
 * still to come ('upcoming'), or is it waiting on the customer ('waiting')?
 */
export function placeJob(booking, nowMs = Date.now()) {
    const b = booking || {};
    const schedule = resolveSchedule(b, nowMs);
    const journey = resolveJourney(b, 'artisan', { schedule });
    const notYet = schedule.scheduled && schedule.isDue === false;
    if (journey.action && !journey.terminal) return { place: 'yours', journey, schedule };
    if (notYet) return { place: 'upcoming', journey, schedule };
    if (journey.terminal) return { place: 'closed', journey, schedule };
    return { place: 'waiting', journey, schedule };
}

/**
 * The Today screen's state.
 * @param {{ artisan: object|null, offers?: object[], bookings?: object[], nowMs?: number }} input
 *        offers: this artisan's open job_offers (data + id); bookings: their active bookings
 */
export function resolveToday({ artisan, offers = [], bookings = [], nowMs = Date.now() } = {}) {
    const placed = bookings.map((b) => ({ booking: b, ...placeJob(b, nowMs) }));
    const yours = placed.filter((p) => p.place === 'yours')
        .sort((a, b) => (JOB_RANK[norm(a.booking.status)] ?? 9) - (JOB_RANK[norm(b.booking.status)] ?? 9));
    const waiting = placed.filter((p) => p.place === 'waiting');
    const upcoming = placed.filter((p) => p.place === 'upcoming')
        .sort((a, b) => (a.schedule.startMs ?? Infinity) - (b.schedule.startMs ?? Infinity));
    const available = storedAvailability(artisan);
    const blocker = artisan ? availabilityBlocker(artisan) : null;

    const base = { available, blocker, jobs: yours, waiting, upcoming };
    if (!artisan) return { ...base, mode: TODAY_MODE.UNKNOWN };

    const open = offers.map((o) => offerView(o, nowMs)).filter((v) => v.answerable)
        .sort((a, b) => (a.countdown?.expiresAtMs ?? Infinity) - (b.countdown?.expiresAtMs ?? Infinity));
    if (open.length && !blocker) {
        return { ...base, mode: TODAY_MODE.OFFER, offer: open[0], moreOffers: open.length - 1, alsoOnJob: yours[0] || null };
    }
    if (yours.length) return { ...base, mode: TODAY_MODE.JOB, job: yours[0] };
    if (blocker) return { ...base, mode: TODAY_MODE.LOCKED };
    return { ...base, mode: available ? TODAY_MODE.ONLINE : TODAY_MODE.OFFLINE };
}
