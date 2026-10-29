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
 *
 * Reads the offer's own `expiresAtMs` first. Since AR-06 every artisan screen
 * shows job_offers/{bookingId} documents, and those carry `expiresAtMs` — they
 * have no `responseDeadline`. Reading only `responseDeadline` meant no countdown
 * was ever shown and a lapsed offer stayed acceptable on screen (audit
 * FLOW-003). A booking document (legacy callers) still answers through
 * `responseDeadline`. The server re-checks expiry on accept regardless.
 *
 * @param {object} offerOrBooking  job_offers or bookings data
 * @returns {{ expiresAtMs: number|null, secondsLeft: number|null, expired: boolean }}
 */
export function offerState(offerOrBooking, nowMs = Date.now()) {
    const o = offerOrBooking || {};
    const expiresAtMs = offerDeadlineMs(o.expiresAtMs) ?? offerDeadlineMs(o.responseDeadline);
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
 * The one look of an offer that can no longer be answered — expired on the
 * clock, or refused by the server (performBookingAction's `offerGone`). It is
 * the dashboard's original treatment, now on every screen that shows an offer:
 * Accept reads "Expired", Accept and Decline are both disabled, at half opacity.
 * Neither is ever re-enabled; the card stays like this until the live listener
 * removes it.
 *
 * LAPSED_OFFER_ATTRS is for markup; lapseOfferButtons() for buttons already on
 * screen (a refusal arriving after the card was drawn). Pure: it touches only
 * the elements it is given.
 */
export const LAPSED_OFFER_LABEL = 'Expired';
export const LAPSED_OFFER_ATTRS = 'disabled aria-disabled="true" data-lapsed="true" style="opacity:.5;cursor:default"';

export function lapseOfferButtons(accept, decline) {
    for (const btn of [accept, decline]) {
        if (!btn) continue;
        btn.disabled = true;
        btn.onclick = null;
        if (typeof btn.removeAttribute === 'function') btn.removeAttribute('onclick');
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-disabled', 'true');
        if (btn.dataset) btn.dataset.lapsed = 'true';
        if (btn.style) { btn.style.opacity = '.5'; btn.style.cursor = 'default'; }
    }
    // Both labels are set: a refusal can arrive while either reads "Accepting…"/"Declining…".
    if (accept)  accept.textContent  = LAPSED_OFFER_LABEL;
    if (decline) decline.textContent = 'Decline';
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
