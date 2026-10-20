/**
 * performanceMetrics.js — what an artisan's performance numbers MEAN, and how
 * dispatch uses them. (AR-12, 2026-10-20)
 *
 * WHY THIS EXISTS
 * ───────────────
 * Nothing ever computed responseRate or completionRate. The performance page
 * read responseRate off the profile (always absent → "0%") and told every
 * artisan to "respond faster"; dispatch scored every candidate with the same
 * fallback constants (rating 4.0 when unrated, completion 0.8, response 0.7),
 * so two of its five inputs never separated anyone.
 *
 * This module is the one definition. functions/shared/performanceMetrics.js is
 * a GENERATED mirror (scripts/build-functions-shared.cjs): the server computes
 * the stored figures and ranks candidates with these functions, and the
 * artisan's page explains the same figures with the same words.
 *
 * RESPONSE RATE — the definition
 * ──────────────────────────────
 * Source events: offer_events/{bookingId}_{round}_{artisanId}, written by the
 * server in the same transaction that closes a job offer (functions/
 * jobOffers.js). The id is deterministic, so a retried or duplicated close
 * cannot count twice, and only offers create events — no unrelated booking
 * can reach the figure.
 *
 *   responded   the artisan accepted or declined before the offer's deadline
 *               (respondToJobOffer refuses a response after it, so every
 *               response on record was in time)
 *   missed      the offer expired with no response
 *   excluded    the customer withdrew the request before the artisan answered
 *               — not the artisan's to answer any more; and any outcome this
 *               module does not know
 *
 *   rate = responded / (responded + missed), over offers CLOSED in the last
 *   90 days, and only once there are at least 5 counted offers. Below that the
 *   rate is null — "not enough requests yet" — never a number built on one
 *   offer. Declining counts as responding: the measure is whether customers
 *   are left waiting, not whether every job is taken.
 *
 * Known limit: a customer-chosen request has no deadline, so it can only end
 * accepted, declined or withdrawn — an artisan who never answers one is not
 * counted as missing it.
 *
 * COMPLETION RATE — the definition
 * ────────────────────────────────
 *   completed / (completed + cancelled BY THE ARTISAN), over bookings assigned
 *   to them, once at least 5 have ended that way. Cancellations by the
 *   customer, the system or an administrator are not the artisan's and are
 *   left out; a cancellation that does not record who made it cannot be
 *   attributed and is left out too.
 */

export const RESPONSE_RATE_POLICY = Object.freeze({ windowDays: 90, minOffers: 5 });
export const COMPLETION_RATE_POLICY = Object.freeze({ minEnded: 5 });

const RESPONDED = ['accepted', 'declined'];
const MISSED    = ['expired'];

/**
 * @param {Array<{ id?, bookingId?, round?, artisanId?, outcome, closedAt }>} events
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ responded, missed, excluded, counted, rate: number|null,
 *            sufficient: boolean, windowDays, minOffers }}
 */
export function computeResponseStats(events, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const { windowDays, minOffers } = RESPONSE_RATE_POLICY;
    const fromMs = nowMs - windowDays * 86400000;
    const seen = new Set();
    let responded = 0, missed = 0, excluded = 0;

    for (const e of Array.isArray(events) ? events : []) {
        if (!e || typeof e !== 'object') continue;
        const key = e.id || `${e.bookingId}_${e.round}_${e.artisanId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const closedMs = Date.parse(e.closedAt);
        if (!Number.isFinite(closedMs) || closedMs < fromMs || closedMs > nowMs + 60000) continue;
        if (RESPONDED.includes(e.outcome)) responded++;
        else if (MISSED.includes(e.outcome)) missed++;
        else excluded++;
    }

    const counted = responded + missed;
    const sufficient = counted >= minOffers;
    return {
        responded, missed, excluded, counted,
        rate: sufficient ? Math.round((responded / counted) * 100) / 100 : null,
        sufficient, windowDays, minOffers,
    };
}

/**
 * @param {Array<{ status, cancelledBy? }>} bookings  bookings assigned to the artisan
 * @returns {{ completed, cancelledByArtisan, ended, rate: number|null, sufficient, minEnded }}
 */
export function computeCompletionStats(bookings) {
    const { minEnded } = COMPLETION_RATE_POLICY;
    let completed = 0, cancelledByArtisan = 0;
    for (const b of Array.isArray(bookings) ? bookings : []) {
        const status = String((b && b.status) || '').toLowerCase();
        if (status === 'completed') completed++;
        else if (status === 'cancelled' && b.cancelledBy === 'artisan') cancelledByArtisan++;
    }
    const ended = completed + cancelledByArtisan;
    const sufficient = ended >= minEnded;
    return {
        completed, cancelledByArtisan, ended,
        rate: sufficient ? Math.round((completed / ended) * 100) / 100 : null,
        sufficient, minEnded,
    };
}

// ── Dispatch ranking ─────────────────────────────────────────────────────────
//
// The weights are the ones dispatch has always used (functions/dispatch.js
// before 2026-10-20) — this module does not invent a new ranking. What changes
// is the INPUTS: a measured value is used when there is enough data behind it,
// and otherwise the old fallback is used as a NEUTRAL value that is the same
// for everyone, so missing data neither rewards nor penalises anyone. A rating
// counts only once it rests on MIN_REVIEWS_FOR_RATING reviews: before, a single
// 1-star or 5-star review moved an artisan by up to 60 points, and `rating || 4`
// also turned a genuine 0 into 4. Below the threshold every artisan sits at the
// same neutral 4.0 — so a new artisan still ranks above one whose measured
// average is below 4.0; that is the neutral prior working as intended, not a
// reward for having no reviews.
export const DISPATCH_WEIGHTS = Object.freeze({
    rating:     15,    // per star (5 stars → 75)
    completion: 20,    // × rate 0–1
    response:   15,    // × rate 0–1
    online:     20,    // currently online
    perKm:      1.5,   // subtracted per km from the job
});
export const DISPATCH_NEUTRAL = Object.freeze({ rating: 4.0, completion: 0.8, response: 0.7 });
export const MIN_REVIEWS_FOR_RATING = 3;

const isRate = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Score one dispatch candidate (an artisan_index document plus _distKm).
 * Returns { score, parts } — parts says which inputs were measured.
 */
export function scoreCandidate(a) {
    const c = a && typeof a === 'object' ? a : {};
    const reviews = Number(c.reviewCount) || 0;
    const ratingMeasured = reviews >= MIN_REVIEWS_FOR_RATING &&
        typeof c.rating === 'number' && c.rating >= 1 && c.rating <= 5;
    const rating     = ratingMeasured ? c.rating : DISPATCH_NEUTRAL.rating;
    const response   = isRate(c.responseRate)   ? c.responseRate   : DISPATCH_NEUTRAL.response;
    const completion = isRate(c.completionRate) ? c.completionRate : DISPATCH_NEUTRAL.completion;
    const dist = typeof c._distKm === 'number' && Number.isFinite(c._distKm) ? c._distKm : null;

    const parts = {
        rating:     { value: rating,     measured: ratingMeasured,          points: rating * DISPATCH_WEIGHTS.rating },
        response:   { value: response,   measured: isRate(c.responseRate),   points: response * DISPATCH_WEIGHTS.response },
        completion: { value: completion, measured: isRate(c.completionRate), points: completion * DISPATCH_WEIGHTS.completion },
        online:     { value: !!c.isOnline, points: c.isOnline ? DISPATCH_WEIGHTS.online : 0 },
        distance:   { value: dist, points: dist === null ? 0 : -dist * DISPATCH_WEIGHTS.perKm },
    };
    const score = Object.values(parts).reduce((s, p) => s + p.points, 0);
    return { score: Math.round(score * 1000) / 1000, parts };
}

/** Rank candidates best-first. Ties break on distance, then id, so order is stable. */
export function rankCandidates(candidates) {
    return (Array.isArray(candidates) ? candidates : [])
        .map((a) => ({ a, s: scoreCandidate(a).score }))
        .sort((x, y) => (y.s - x.s) ||
            ((x.a._distKm ?? Infinity) - (y.a._distKm ?? Infinity)) ||
            String(x.a.id || '').localeCompare(String(y.a.id || '')))
        .map(({ a, s }) => Object.assign(a, { _score: s }));
}
