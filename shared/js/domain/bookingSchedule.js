/**
 * bookingSchedule.js — THE single source of truth for "when is this booking?".
 *
 * WHY THIS EXISTS
 * ───────────────
 * HandyHub had a booking engine that could only ever express one moment: now.
 *
 * `bookingRepository.js` documented `scheduledAt` as "ISO timestamp of the
 * appointment" and no code ever wrote it — the only value it ever held was the
 * literal `null` that book-emergency.html writes, yet four surfaces read it and
 * rendered whatever they found. `createInspectionBooking` accepted, validated
 * and persisted a `scheduledFor`, `resolveJobBrief` projected it and artisan
 * job.html rendered it — and no caller ever passed one. The rail was laid end
 * to end with nothing on it.
 *
 * Because no booking carried a time, `onBookingCreated` dispatched every
 * booking the instant it was written, the artisan was given three minutes to
 * respond, and `accepted` was wired straight through to `en_route`. A request
 * for next Saturday was therefore indistinguishable, at every decision point
 * that mattered, from "my kitchen is flooding".
 *
 * THE MODEL
 * ─────────
 * `track` answers WHICH LIFECYCLE (inspection / emergency / standard).
 * This module answers WHEN — an orthogonal question, deliberately kept in an
 * orthogonal field rather than a fourth track. A scheduled inspection is still
 * an inspection: same callout fee, same quote, same escrow. Only its timing
 * differs.
 *
 *   scheduledForMs == null  →  IMMEDIATE. "Come as soon as someone can."
 *   scheduledForMs  > 0     →  APPOINTMENT. "Come in this window."
 *
 * Absence means immediate, so every booking written before scheduling existed
 * classifies correctly with no migration and no backfill.
 *
 * ASSIGN NOW, SERVE LATER
 * ───────────────────────
 * A scheduled booking is dispatched immediately — the customer gets a named,
 * committed professional today, and the callout fee (payable only once an
 * artisan has accepted) can be secured today. What acceptance does NOT do is
 * start the job: `canStartWork()` below is the gate that keeps "I commit to
 * your Saturday slot" from meaning "I am on my way now". That separation is
 * the whole point of this module.
 *
 * TIME IS ABSOLUTE, WALL CLOCK IS GHANAIAN
 * ────────────────────────────────────────
 * A customer picks a wall clock ("Saturday, 2pm"). A phone with the wrong
 * timezone would otherwise turn that into a different instant than the one the
 * artisan is told — the classic booking bug. So the wall clock is interpreted
 * explicitly in Africa/Accra and stored as an ABSOLUTE instant. Ghana is UTC+0
 * all year with no daylight saving, which is why this is a constant and not a
 * timezone database: GMT is Ghana Mean Time.
 *
 * `scheduledForMs` (epoch milliseconds) is stored alongside the ISO string
 * because Firestore Rules cannot parse an ISO-8601 string. Rules compare
 * `request.time.toMillis()` against the number; every other consumer can read
 * either. They are written together, by the server, in one operation.
 *
 * NO IMPORTS — evaluates in every browser context and is consumed by the
 * customer app, the artisan app, the Cloud Functions runtime and the Node test
 * suite alike. (Same constraint, same reason, as bookingTruth.js.)
 */

// ── Ghana is UTC+0, year round, no DST ───────────────────────────────────────
// Not a simplification — Africa/Accra has had a zero offset since 1942 and
// observes no daylight saving. Named as a constant so the assumption is
// visible and greppable rather than implied by the absence of conversion code.
export const ACCRA_UTC_OFFSET_MINUTES = 0;

// ── Selectable arrival windows ───────────────────────────────────────────────
//
// A window, not an instant. An artisan crossing Accra cannot honour "14:00",
// and pretending otherwise manufactures a broken promise on every booking. The
// customer is told a window, the artisan commits to a window, and canStartWork
// opens on the window.
//
// `startHour` is Accra wall-clock. `durationMins` is how long the window runs.
export const TIME_WINDOWS = Object.freeze([
    { id: 'morning',   label: 'Morning',       clock: '8:00 – 11:00',  startHour: 8,  durationMins: 180 },
    { id: 'midday',    label: 'Midday',        clock: '11:00 – 14:00', startHour: 11, durationMins: 180 },
    { id: 'afternoon', label: 'Afternoon',     clock: '14:00 – 17:00', startHour: 14, durationMins: 180 },
    { id: 'evening',   label: 'Early evening', clock: '17:00 – 19:00', startHour: 17, durationMins: 120 },
]);

export function findWindow(windowId) {
    return TIME_WINDOWS.find(w => w.id === windowId) || null;
}

// ── Booking horizon rules ────────────────────────────────────────────────────

/**
 * Minimum lead time. A window must start at least this far ahead to be
 * bookable, so "book the morning slot at 10:55" cannot happen.
 *
 * Two hours is the dispatch-plus-travel floor: the artisan has to be found,
 * accept, and cross a city. Below that the honest product is the immediate
 * flow, which is exactly what the UI offers instead.
 */
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000;

/** How far ahead a customer may book. Beyond this, availability is fiction. */
export const MAX_HORIZON_DAYS = 30;

/**
 * How early before the window an artisan may set out.
 *
 * This is the load-bearing number in the accept-vs-commence separation. It has
 * to be generous enough that a professional who leaves early to beat Accra
 * traffic is not blocked by their own app, and tight enough that "Mark En
 * Route" on Monday for a Saturday appointment is refused. Ninety minutes
 * before a three-hour window means travel can begin well before the customer's
 * earliest expected arrival, and not a day before it.
 */
export const EARLY_START_GRACE_MS = 90 * 60 * 1000;

/**
 * How long before the window reminders go out. Late enough to be actionable,
 * early enough that a customer can still arrange to be home for it.
 */
export const REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;

// ── Primitives ───────────────────────────────────────────────────────────────

const MS_PER_DAY  = 86400000;
const DAY_NAMES   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** Finite-number coercion. Returns null (UNKNOWN), never 0, for bad input. */
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Interpret a wall-clock date + hour in Africa/Accra and return the absolute
 * instant in epoch milliseconds.
 *
 * `new Date('2026-09-20T14:00')` would parse in the DEVICE's timezone — a
 * customer whose phone is set to London in October books an hour earlier than
 * they chose, and the artisan is told the wrong time. Date.UTC plus the
 * explicit Accra offset removes the device from the calculation entirely.
 *
 * @param {string} dateStr  'YYYY-MM-DD' wall-clock date in Accra
 * @param {number} hour     0-23 wall-clock hour in Accra
 * @param {number} [minute]
 * @returns {number|null}   epoch ms, or null if the input is not a real date
 */
export function accraWallClockToMs(dateStr, hour, minute = 0) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr == null ? '' : dateStr).trim());
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const h = num(hour), mi = num(minute) === null ? 0 : num(minute);
    if (h === null || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

    const ms = Date.UTC(y, mo - 1, d, h, mi, 0, 0) - ACCRA_UTC_OFFSET_MINUTES * 60000;
    // Round-trip guard: Date.UTC silently rolls 2026-02-31 into March. A date
    // the customer could not have meant must be rejected, not quietly moved.
    const back = new Date(ms + ACCRA_UTC_OFFSET_MINUTES * 60000);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms;
}

/** The Accra wall-clock calendar date ('YYYY-MM-DD') of an absolute instant. */
export function accraDateString(ms) {
    const n = num(ms);
    if (n === null) return null;
    const d = new Date(n + ACCRA_UTC_OFFSET_MINUTES * 60000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Accra wall-clock parts of an absolute instant. */
function accraParts(ms) {
    const d = new Date(num(ms) + ACCRA_UTC_OFFSET_MINUTES * 60000);
    return {
        year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(),
        day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    };
}

function clock12(hour, minute) {
    const suffix = hour < 12 ? 'am' : 'pm';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return minute ? h12 + ':' + pad2(minute) + suffix : h12 + suffix;
}

/**
 * Human label for an appointment, relative to `nowMs` so "Today" and "Tomorrow"
 * are correct rather than a bare date the reader has to decode.
 *
 * @returns {string|null} e.g. "Today, 2-5pm" | "Sat 20 Sep, 8-11am"
 */
export function formatAppointment(startMs, durationMins = 180, nowMs = Date.now()) {
    const start = num(startMs);
    if (start === null) return null;
    const dur = num(durationMins) === null ? 180 : num(durationMins);
    const s = accraParts(start);
    const e = accraParts(start + dur * 60000);

    const today    = accraDateString(nowMs);
    const thisDate = accraDateString(start);
    const tomorrow = accraDateString(nowMs + MS_PER_DAY);

    const dayLabel =
        thisDate === today    ? 'Today'    :
        thisDate === tomorrow ? 'Tomorrow' :
        DAY_NAMES[s.day].slice(0, 3) + ' ' + s.date + ' ' + MONTH_NAMES[s.month];

    if (dur <= 0) return dayLabel + ', ' + clock12(s.hour, s.minute);

    // "8-11am" reads better than "8am-11am" when both ends share a meridiem.
    const sameMeridiem = (s.hour < 12) === (e.hour < 12);
    const startPart = sameMeridiem
        ? (s.minute ? (s.hour % 12 || 12) + ':' + pad2(s.minute) : String(s.hour % 12 || 12))
        : clock12(s.hour, s.minute);

    return dayLabel + ', ' + startPart + '–' + clock12(e.hour, e.minute);
}

// ── The projection ───────────────────────────────────────────────────────────

/**
 * Everything any surface is allowed to say about a booking's timing.
 *
 * Returns `scheduled: false` for every booking without an appointment — which
 * is every booking HandyHub had ever written before this module existed, and
 * every emergency booking forever. That is not a missing value; "as soon as
 * possible" is a real, correct answer and is rendered as one.
 *
 * @param {object} booking
 * @param {number} [nowMs]
 * @returns {{
 *   scheduled: boolean, startMs: number|null, endMs: number|null,
 *   windowMins: number|null, iso: string|null, opensAtMs: number|null,
 *   isDue: boolean, isPast: boolean, startsInMs: number|null,
 *   label: string|null, kind: 'immediate'|'appointment'
 * }}
 */
export function resolveSchedule(booking, nowMs = Date.now()) {
    const b = booking || {};

    // scheduledForMs is the authoritative field (a number Rules can compare).
    // The ISO string is parsed only as a fallback for a document written before
    // the numeric field existed — never preferred over it, so the two can never
    // disagree in favour of the softer one.
    let startMs = num(b.scheduledForMs);
    if (startMs === null && b.scheduledFor) {
        const t = Date.parse(b.scheduledFor);
        if (Number.isFinite(t)) startMs = t;
    }

    if (startMs === null) {
        return {
            scheduled: false, startMs: null, endMs: null, windowMins: null, iso: null,
            opensAtMs: null, isDue: true, isPast: false, startsInMs: null,
            label: null, kind: 'immediate',
        };
    }

    const windowMins = num(b.scheduleWindowMins) === null ? 180 : num(b.scheduleWindowMins);
    const endMs      = startMs + windowMins * 60000;
    const opensAtMs  = startMs - EARLY_START_GRACE_MS;

    return {
        scheduled:  true,
        startMs,
        endMs,
        windowMins,
        iso:        new Date(startMs).toISOString(),
        opensAtMs,
        // "Due" means the job may legitimately begin — not that the window has
        // arrived. The grace is part of the appointment's meaning, not a fudge.
        isDue:      nowMs >= opensAtMs,
        isPast:     nowMs > endMs,
        startsInMs: startMs - nowMs,
        label:      formatAppointment(startMs, windowMins, nowMs),
        kind:       'appointment',
    };
}

/**
 * May work begin on this booking right now?
 *
 * THE separation this module exists for. An artisan accepting a Saturday
 * appointment on Monday has committed to Saturday; `accepted` is an assignment,
 * not a starting gun. Mirrored in firestore.rules so a client that ignores this
 * answer is refused by the server, and in getAllowedActions so the button is
 * never offered in the first place.
 *
 * @returns {{allowed: boolean, reason: string|null, opensAtMs: number|null}}
 */
export function canStartWork(booking, nowMs = Date.now()) {
    const s = resolveSchedule(booking, nowMs);
    if (!s.scheduled) return { allowed: true, reason: null, opensAtMs: null };
    if (s.isDue)      return { allowed: true, reason: null, opensAtMs: s.opensAtMs };
    return {
        allowed: false,
        opensAtMs: s.opensAtMs,
        reason: 'This visit is booked for ' + s.label + '. You can set out from ' +
                formatAppointment(s.opensAtMs, 0, nowMs) + '.',
    };
}

// ── Request validation (shared by the client form and the Cloud Function) ────

/**
 * Validate a customer's requested appointment and canonicalise it to an
 * absolute instant.
 *
 * The SAME function runs in the browser (so the customer is told immediately
 * why a slot is unavailable) and in createInspectionBooking (so the answer is
 * authoritative). One rule set, one set of messages — the client cannot be more
 * permissive than the server, because it is the same code.
 *
 * @param {{ dateStr: string, windowId: string }} req
 * @param {number} [nowMs]
 * @returns {{ ok: boolean, reason?: string, startMs?: number, iso?: string,
 *             windowMins?: number, label?: string }}
 */
export function validateScheduleRequest(req, nowMs = Date.now()) {
    const { dateStr, windowId } = req || {};
    const win = findWindow(windowId);
    if (!win) return { ok: false, reason: 'Choose an arrival window.' };

    const startMs = accraWallClockToMs(dateStr, win.startHour, 0);
    if (startMs === null) return { ok: false, reason: 'That is not a valid date.' };

    if (startMs < nowMs) {
        return { ok: false, reason: 'That time has already passed — pick a later slot.' };
    }
    if (startMs - nowMs < MIN_LEAD_MS) {
        return {
            ok: false,
            reason: 'We need about two hours to get a professional to you. Pick a later slot, or choose "As soon as possible".',
        };
    }
    // The horizon is CALENDAR days, not an exact 30x24h span.
    //
    // Measured in milliseconds, the last selectable date is only partly
    // bookable: at 13:30 today, the 14:00 and 17:00 windows on day 30 fall
    // outside the span and are refused, so the customer is shown a date they
    // are allowed to pick with half its windows greyed out for a reason they
    // cannot act on. "Up to 30 days ahead" means 30 days, and a day is either
    // in range or it is not.
    if (String(dateStr).trim() > latestSelectableDate(nowMs)) {
        return { ok: false, reason: 'You can book up to ' + MAX_HORIZON_DAYS + ' days ahead.' };
    }

    return {
        ok: true,
        startMs,
        iso: new Date(startMs).toISOString(),
        windowMins: win.durationMins,
        label: formatAppointment(startMs, win.durationMins, nowMs),
    };
}

/**
 * Which windows are still bookable on a given calendar date.
 * Drives the picker so a customer is never offered a slot the server refuses.
 */
export function availableWindowsFor(dateStr, nowMs = Date.now()) {
    return TIME_WINDOWS.map((w) => {
        const v = validateScheduleRequest({ dateStr, windowId: w.id }, nowMs);
        return Object.assign({}, w, { available: v.ok, reason: v.ok ? null : v.reason });
    });
}

/** First calendar date (Accra) a customer may pick — today. */
export function earliestSelectableDate(nowMs = Date.now()) {
    return accraDateString(nowMs);
}

/** Last calendar date a customer may pick. */
export function latestSelectableDate(nowMs = Date.now()) {
    return accraDateString(nowMs + MAX_HORIZON_DAYS * MS_PER_DAY);
}

// ── How long a request may wait for a professional ───────────────────────────
//
// A request nobody accepted used to wait forever: one sat at "Finding your
// professional — we've been searching for 1879 minutes" because nothing ended a
// search that was not making progress. The search now has a deadline, and the
// customer is told it. Past it the dispatch sweep (functions/dispatch.js
// expireStaleSearches) closes the request as unfulfilled, withdraws any open
// offer, refunds anything held, and notifies the customer.
//
//   immediate request   SEARCH_WINDOW_MS after it was made
//   booked appointment  the appointment's start — after that nobody can be
//                       there on time, so the request is over

/** An immediate request is searched for at most this long. */
export const SEARCH_WINDOW_MS = 60 * 60 * 1000;

/**
 * The moment the search for this request ends, in ms — or null when the
 * request has no usable creation time (the caller then leaves it alone).
 */
export function searchDeadlineMs(booking, nowMs = Date.now()) {
    const b = booking || {};
    const appt = resolveSchedule(b, nowMs);
    if (appt.scheduled) return appt.startMs;
    const created = typeof b.createdAt === 'string' ? Date.parse(b.createdAt)
                  : b.createdAt && typeof b.createdAt.toMillis === 'function' ? b.createdAt.toMillis()
                  : Number(b.createdAt);
    return Number.isFinite(created) && created > 0 ? created + SEARCH_WINDOW_MS : null;
}
