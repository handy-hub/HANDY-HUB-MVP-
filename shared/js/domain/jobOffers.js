/**
 * jobOffers.js — the facts about a job offer an artisan is looking at.
 *
 * Pure (no imports), shared by the artisan dashboard and
 * tests/push-delivery.test.cjs. Push is one way an offer reaches an artisan;
 * the dashboard's live listener is the other, and the only one that works when
 * push is off, blocked or broken. These helpers keep that second path honest:
 * when an offer expires, and which offers have just arrived.
 */

/**
 * A booking's responseDeadline in milliseconds, whatever shape it arrived in:
 * a Firestore Timestamp (live listener), a plain {seconds, nanoseconds} object
 * (a cached or serialised copy), an ISO string, or a number of milliseconds or
 * seconds. Null when there is no usable deadline — never NaN.
 */
export function offerDeadlineMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object' && typeof v.toMillis === 'function') {
        const n = Number(v.toMillis());
        return Number.isFinite(n) ? n : null;
    }
    if (typeof v === 'object') {
        const s  = Number(v.seconds ?? v._seconds);
        const ns = Number(v.nanoseconds ?? v._nanoseconds ?? 0);
        return Number.isFinite(s) ? s * 1000 + Math.floor((Number.isFinite(ns) ? ns : 0) / 1e6) : null;
    }
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || v <= 0) return null;
        // Milliseconds vs seconds since the epoch: 1e11 ms is 1973 and 1e11 s is
        // the year 5138, so no real value of either kind lands on the wrong side.
        return v >= 1e11 ? v : v * 1000;
    }
    if (typeof v === 'string') {
        const n = Date.parse(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Where an offer stands right now.
 * @returns {{ expiresAtMs: number|null, secondsLeft: number|null, expired: boolean }}
 */
export function offerState(booking, nowMs = Date.now()) {
    const expiresAtMs = offerDeadlineMs(booking && booking.responseDeadline);
    if (expiresAtMs === null) return { expiresAtMs: null, secondsLeft: null, expired: false };
    return {
        expiresAtMs,
        secondsLeft: Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)),
        expired: nowMs >= expiresAtMs,
    };
}

/** "2:05", "45s" — how long is left, the way the artisan reads it. */
export function formatTimeLeft(secondsLeft) {
    const s = Math.max(0, Math.floor(Number(secondsLeft) || 0));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Tells which offers in a listener snapshot are NEW. The first snapshot after a
 * page load only primes it — those offers are already on the screen being
 * looked at. An offer that leaves and comes back (re-offered in a later round)
 * counts as new again.
 */
export function createOfferWatcher() {
    let seen = null;
    return {
        next(ids) {
            const current = (ids || []).filter(Boolean).map(String);
            if (seen === null) { seen = new Set(current); return []; }
            const fresh = current.filter((id) => !seen.has(id));
            seen = new Set(current);
            return fresh;
        },
    };
}
