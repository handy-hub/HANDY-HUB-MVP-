/**
 * shared/js/domain/artisanReputation.js — the artisan's Reputation: what each
 * figure is, where it comes from, and what dispatch really does with it (Phase 4).
 *
 * Pure: no DOM, no Firebase. Every rule is the one production uses:
 *
 *   matching        performanceMetrics.scoreCandidate / DISPATCH_WEIGHTS — the
 *                   function functions/dispatch.js ranks candidates with
 *   rating          artisans/{id}.rating + reviewCount (functions onBookingReviewed);
 *                   counted for matching only from MIN_REVIEWS_FOR_RATING (3)
 *   response rate   artisans/{id}.responseStats (server, from offer_events): 90 days,
 *                   at least 5 requests (RESPONSE_RATE_POLICY)
 *   completion      computed from the artisan's own ended bookings, 5 at least
 *                   (COMPLETION_RATE_POLICY) — and NOT used for matching today:
 *                   functions/artisanIndex.js writes completionRate: null, so
 *                   every candidate scores the same neutral value
 *   online          artisans/{id}.isOnline + lastHeartbeat within 15 minutes
 *                   (artisanIndex LIVENESS_WINDOW_MS)
 *   reach           artisans/{id}.workRadius (20 km when unset) — a filter, not a score
 *   level           jobsCompleted milestones — not used for matching at all
 *
 * Below a threshold a figure is "not enough yet", never a number and never 0.
 */
import { DISPATCH_WEIGHTS, DISPATCH_NEUTRAL, MIN_REVIEWS_FOR_RATING, RESPONSE_RATE_POLICY,
         COMPLETION_RATE_POLICY, computeCompletionStats } from './performanceMetrics.js';

/** functions/artisanIndex.js LIVENESS_WINDOW_MS — pinned by tests/artisan-reputation.test.cjs. */
export const LIVENESS_WINDOW_MS = 15 * 60 * 1000;
/** functions/dispatch.js: `a.workRadius || 20`. */
export const DEFAULT_WORK_RADIUS_KM = 20;
/** Milestones by completed jobs (the dashboard's levels). Recognition only. */
export const LEVELS = Object.freeze([
    { name: 'New',     from: 0 },
    { name: 'Rising',  from: 20 },
    { name: 'Pro',     from: 50 },
    { name: 'Top Pro', from: 100 },
]);

const ms = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'object' && Number.isFinite(Number(v.seconds))) return Number(v.seconds) * 1000;
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : null;
};

export function ratingFigure(artisan) {
    const a = artisan || {};
    const count = Number.isFinite(Number(a.reviewCount)) ? Math.max(0, Math.floor(Number(a.reviewCount))) : 0;
    const value = Number(a.rating);
    const valid = Number.isFinite(value) && value >= 1 && value <= 5;
    const measured = count >= MIN_REVIEWS_FOR_RATING && valid;
    return {
        count, minimum: MIN_REVIEWS_FOR_RATING,
        value: measured ? Math.round(value * 10) / 10 : null,
        measured, needed: Math.max(0, MIN_REVIEWS_FOR_RATING - count),
        // A positive count with an unusable score is a data fault, said as such.
        fault: count > 0 && !valid,
        usedInMatching: measured,
        neutral: DISPATCH_NEUTRAL.rating,
    };
}

export function responseFigure(artisan) {
    const rs = (artisan && artisan.responseStats) || null;
    const counted = rs && Number.isFinite(Number(rs.counted)) ? Number(rs.counted) : 0;
    const measured = !!(rs && rs.sufficient === true && typeof rs.rate === 'number' && Number.isFinite(rs.rate));
    return {
        responded: rs && Number.isFinite(Number(rs.responded)) ? Number(rs.responded) : 0,
        missed: rs && Number.isFinite(Number(rs.missed)) ? Number(rs.missed) : 0,
        counted, minimum: RESPONSE_RATE_POLICY.minOffers, windowDays: RESPONSE_RATE_POLICY.windowDays,
        pct: measured ? Math.round(rs.rate * 100) : null,
        measured, needed: Math.max(0, RESPONSE_RATE_POLICY.minOffers - counted),
        computedAt: rs && rs.computedAt || null,
        usedInMatching: measured,
        neutral: DISPATCH_NEUTRAL.response,
    };
}

export function completionFigure(endedBookings) {
    const c = computeCompletionStats(endedBookings);
    return { ...c, minimum: COMPLETION_RATE_POLICY.minEnded, pct: c.rate === null ? null : Math.round(c.rate * 100),
             measured: c.sufficient, needed: Math.max(0, COMPLETION_RATE_POLICY.minEnded - c.ended),
             // functions/artisanIndex.js: completionRate is null for every candidate.
             usedInMatching: false, neutral: DISPATCH_NEUTRAL.completion };
}

export function onlineFigure(artisan, nowMs = Date.now()) {
    const a = artisan || {};
    const seenMs = ms(a.lastHeartbeat);
    const recent = seenMs !== null && nowMs - seenMs <= LIVENESS_WINDOW_MS;
    return {
        available: a.isAvailable === true,
        onlineNow: a.isOnline === true && recent,
        lastSeenMs: seenMs,
        windowMinutes: LIVENESS_WINDOW_MS / 60000,
        points: DISPATCH_WEIGHTS.online,
    };
}

export function levelFigure(artisan) {
    const jobs = Number.isFinite(Number(artisan && artisan.jobsCompleted)) ? Math.max(0, Math.floor(Number(artisan.jobsCompleted))) : 0;
    let i = 0;
    for (let k = 0; k < LEVELS.length; k++) if (jobs >= LEVELS[k].from) i = k;
    const next = LEVELS[i + 1] || null;
    return { name: LEVELS[i].name, jobs, next: next ? { name: next.name, from: next.from, toGo: next.from - jobs } : null, usedInMatching: false };
}

/**
 * How matching works, in the algorithm's own numbers (DISPATCH_WEIGHTS), with
 * this artisan's standing on each input. Nothing here is a promise of rank.
 */
export function matchingFactors({ rating, response, completion, online }) {
    const W = DISPATCH_WEIGHTS;
    return [
        { key: 'distance', label: 'Distance to the job', effect: `${W.perKm} points less for every km`, yours: 'Depends on each job', counts: true },
        { key: 'online', label: 'Online and seen in the app', effect: `${W.online} points`, yours: online.onlineNow ? 'Online now' : 'Not online now', counts: true },
        { key: 'rating', label: 'Rating', effect: `${W.rating} points per star`,
          yours: rating.measured ? `${rating.value.toFixed(1)} counts` : `Counted as ${rating.neutral.toFixed(1)} until you have ${rating.minimum} reviews`, counts: true },
        { key: 'response', label: 'Response rate', effect: `Up to ${W.response} points`,
          yours: response.measured ? `${response.pct}% counts` : `Counted as ${Math.round(response.neutral * 100)}% until you have ${response.minimum} requests in ${response.windowDays} days`, counts: true },
        { key: 'completion', label: 'Completion rate', effect: 'Not used yet',
          yours: `Everyone is counted the same (${Math.round(completion.neutral * 100)}%) until it is measured`, counts: false },
    ];
}

/** Who can be offered a job at all (functions/dispatch.js filters, before any score). */
export function eligibility(artisan) {
    const a = artisan || {};
    const radius = Number(a.workRadius);
    return {
        verified: String(a.verificationStatus || '').toLowerCase() === 'approved',
        active: String(a.status || '').toLowerCase() === 'active',
        available: a.isAvailable === true,
        workRadiusKm: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_WORK_RADIUS_KM,
        radiusDefaulted: !(Number.isFinite(radius) && radius > 0),
    };
}

/**
 * Reviews from rated bookings, newest first, as the customers left them.
 * @param {object[]} bookings  the artisan's bookings carrying a rating (data + id)
 */
export function reviewList(bookings = []) {
    return bookings
        .filter((b) => b && Number.isInteger(Number(b.rating)) && Number(b.rating) >= 1 && Number(b.rating) <= 5)
        .map((b) => ({ bookingId: b.id, rating: Number(b.rating), text: typeof b.review === 'string' && b.review.trim() ? b.review.trim() : null,
                       at: ms(b.reviewedAt) ?? ms(b.completedAt) ?? ms(b.updatedAt), customer: typeof b.customerFirstName === 'string' ? b.customerFirstName : null,
                       service: b.serviceType || b.service || null }))
        .sort((x, y) => (y.at ?? 0) - (x.at ?? 0));
}

/**
 * The server's rating against the reviews read, when every review has been read.
 * A difference is shown, not smoothed over.
 */
export function ratingConsistency(artisan, reviews, allLoaded) {
    if (!allLoaded) return { checked: false };
    const r = ratingFigure(artisan);
    const n = reviews.length;
    const mean = n ? reviews.reduce((s, x) => s + x.rating, 0) / n : null;
    const countOk = n === r.count;
    const meanOk = n === 0 ? true : Math.abs(mean - Number(artisan && artisan.rating)) < 0.051;
    return { checked: true, ok: countOk && meanOk, count: n, serverCount: r.count,
             mean: mean === null ? null : Math.round(mean * 100) / 100 };
}

/** Everything the Reputation screen draws. */
export function reputationModel({ artisan, endedBookings = [], ratedBookings = [], reviewsComplete = false, nowMs = Date.now() } = {}) {
    const rating = ratingFigure(artisan);
    const response = responseFigure(artisan);
    const completion = completionFigure(endedBookings);
    const online = onlineFigure(artisan, nowMs);
    const reviews = reviewList(ratedBookings);
    return {
        rating, response, completion, online,
        level: levelFigure(artisan),
        eligibility: eligibility(artisan),
        factors: matchingFactors({ rating, response, completion, online }),
        reviews,
        consistency: ratingConsistency(artisan, reviews, reviewsComplete),
    };
}
