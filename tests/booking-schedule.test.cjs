/**
 * booking-schedule.test.cjs
 *
 * "I need someone now" versus "I need someone on Saturday at two", pinned.
 *
 * HandyHub's booking engine could previously express exactly one moment: now.
 * `scheduledAt` was documented as the appointment field and no code ever wrote
 * it; `scheduledFor` was validated and stored by createInspectionBooking and no
 * caller ever passed it. With no booking carrying a time, onBookingCreated
 * dispatched everything immediately, artisans were given three minutes to
 * answer, and `accepted` flowed straight into `en_route`. A request for next
 * Saturday was indistinguishable from a burst pipe at every decision point.
 *
 * These tests exist so that the distinction is a CHECKED property, not a
 * comment — and specifically so the three things most likely to be quietly
 * broken by a later change stay true:
 *
 *   1. No appointment means "now". Every booking written before scheduling
 *      existed, and every emergency booking forever, must keep behaving exactly
 *      as it did — absence of a schedule is not a missing value.
 *   2. A wall clock is interpreted in Africa/Accra, never in the device's
 *      timezone. A phone set to the wrong zone must not book the customer into
 *      a slot they did not choose.
 *   3. Acceptance is not commencement. Committing to Saturday must never
 *      authorise setting out on Monday — and the number that decides this is
 *      pinned across the ES module, the Cloud Functions mirror, and
 *      firestore.rules.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const ROOT = path.join(__dirname, '..');

function stripEsm(src) {
    return src
        .replace(/^\s*import\s[^\n]*\n/gm, '')
        .replace(/^\s*export\s+async\s+function\s+/gm, 'async function ')
        .replace(/^\s*export\s+function\s+/gm, 'function ')
        .replace(/^\s*export\s+const\s+/gm, 'const ');
}
function loadDomain(file, returns) {
    const body = stripEsm(fs.readFileSync(path.join(ROOT, 'shared', 'js', 'domain', file), 'utf8'));
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { ${returns.join(', ')} };`)();
}

const SCHED = loadDomain('bookingSchedule.js', [
    'resolveSchedule', 'canStartWork', 'validateScheduleRequest', 'availableWindowsFor',
    'accraWallClockToMs', 'accraDateString', 'formatAppointment', 'findWindow',
    'earliestSelectableDate', 'latestSelectableDate',
    'TIME_WINDOWS', 'MIN_LEAD_MS', 'MAX_HORIZON_DAYS', 'EARLY_START_GRACE_MS',
    'REMINDER_LEAD_MS', 'ACCRA_UTC_OFFSET_MINUTES',
]);

const META = (() => {
    const body = stripEsm(fs.readFileSync(
        path.join(ROOT, 'shared', 'js', 'domain', 'bookingStatusMeta.js'), 'utf8'));
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn { describe, getAllowedActions };`)();
})();

let passed = 0, failed = 0;
function t(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

// A fixed "now" so every assertion is deterministic. Friday 11 Sep 2026, 09:00
// Accra — a weekday morning, so "today" still has afternoon windows left.
const NOW = Date.parse('2026-09-11T09:00:00Z');
const SAT_2PM = Date.parse('2026-09-19T14:00:00Z');   // a week out

const scheduled = (over) => Object.assign({
    status: 'accepted', track: 'inspection',
    scheduledForMs: SAT_2PM, scheduleWindowMins: 180,
}, over);
const immediate = (over) => Object.assign({ status: 'accepted', track: 'inspection' }, over);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. Absence of a schedule means NOW ───────────────────────────');

t('a booking with no schedule fields is immediate, not unknown', () => {
    const s = SCHED.resolveSchedule({}, NOW);
    assert.strictEqual(s.scheduled, false);
    assert.strictEqual(s.kind, 'immediate');
    assert.strictEqual(s.label, null);
});

t('an immediate booking is ALWAYS due — work may begin at once', () => {
    assert.strictEqual(SCHED.resolveSchedule({}, NOW).isDue, true);
    assert.strictEqual(SCHED.canStartWork({}, NOW).allowed, true);
});

t('an emergency booking (scheduledAt:null, as book-emergency writes) is immediate', () => {
    // This is the literal shape book-emergency.html writes. It must never be
    // read as an appointment.
    const em = { type: 'emergency', status: 'pending', scheduledAt: null };
    const s  = SCHED.resolveSchedule(em, NOW);
    assert.strictEqual(s.scheduled, false);
    assert.strictEqual(SCHED.canStartWork(em, NOW).allowed, true);
});

t('the legacy scheduledAt field is NOT mistaken for an appointment', () => {
    // scheduledAt was documented as the appointment field and never written.
    // Only scheduledFor / scheduledForMs carry authority.
    const s = SCHED.resolveSchedule({ scheduledAt: '2026-09-19T14:00:00Z' }, NOW);
    assert.strictEqual(s.scheduled, false);
});

t('scheduledForMs wins over a disagreeing scheduledFor string', () => {
    const s = SCHED.resolveSchedule({
        scheduledForMs: SAT_2PM,
        scheduledFor:   '2020-01-01T00:00:00Z',   // stale/forged
    }, NOW);
    assert.strictEqual(s.startMs, SAT_2PM);
});

t('a scheduledFor string alone still resolves (pre-numeric-field documents)', () => {
    const s = SCHED.resolveSchedule({ scheduledFor: '2026-09-19T14:00:00.000Z' }, NOW);
    assert.strictEqual(s.scheduled, true);
    assert.strictEqual(s.startMs, SAT_2PM);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 2. Wall clock is Ghanaian, instants are absolute ─────────────');

t('Ghana runs at UTC+0 — the assumption is explicit, not implied', () => {
    assert.strictEqual(SCHED.ACCRA_UTC_OFFSET_MINUTES, 0);
});

t('a wall clock is interpreted in Accra, not in the device timezone', () => {
    assert.strictEqual(SCHED.accraWallClockToMs('2026-09-19', 14), SAT_2PM);
});

t('an impossible date is rejected, never silently rolled forward', () => {
    // Date.UTC(2026, 1, 31) quietly becomes 3 March. A customer cannot mean
    // 31 February, so it must not become a booking.
    assert.strictEqual(SCHED.accraWallClockToMs('2026-02-31', 10), null);
    assert.strictEqual(SCHED.accraWallClockToMs('2026-13-01', 10), null);
    assert.strictEqual(SCHED.accraWallClockToMs('not-a-date', 10), null);
    assert.strictEqual(SCHED.accraWallClockToMs('2026-09-19', 25), null);
});

t('a leap day in a leap year is accepted', () => {
    assert.ok(SCHED.accraWallClockToMs('2028-02-29', 8) !== null);
    assert.strictEqual(SCHED.accraWallClockToMs('2026-02-29', 8), null);
});

t('an appointment reads as a window, relative to today', () => {
    assert.strictEqual(SCHED.formatAppointment(SAT_2PM, 180, NOW), 'Sat 19 Sep, 2–5pm');
    const todayPm = SCHED.accraWallClockToMs('2026-09-11', 14);
    assert.strictEqual(SCHED.formatAppointment(todayPm, 180, NOW), 'Today, 2–5pm');
    const tomorrowAm = SCHED.accraWallClockToMs('2026-09-12', 8);
    assert.strictEqual(SCHED.formatAppointment(tomorrowAm, 180, NOW), 'Tomorrow, 8–11am');
});

t('a window crossing midday names both meridiems', () => {
    const am = SCHED.accraWallClockToMs('2026-09-19', 11);
    assert.strictEqual(SCHED.formatAppointment(am, 180, NOW), 'Sat 19 Sep, 11am–2pm');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 3. Which slots may be booked ─────────────────────────────────');

t('a valid future slot is accepted and canonicalised', () => {
    const v = SCHED.validateScheduleRequest({ dateStr: '2026-09-19', windowId: 'afternoon' }, NOW);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.startMs, SAT_2PM);
    assert.strictEqual(v.iso, '2026-09-19T14:00:00.000Z');
    assert.strictEqual(v.windowMins, 180);
});

t('a date in the past is refused', () => {
    const v = SCHED.validateScheduleRequest({ dateStr: '2026-09-01', windowId: 'morning' }, NOW);
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /already passed/i);
});

t('a slot inside the minimum lead time is refused', () => {
    // 09:00 now; the 11:00 midday window is only two hours out — exactly at the
    // boundary, and boundaries are where booking systems break.
    const tooSoon = SCHED.validateScheduleRequest({ dateStr: '2026-09-11', windowId: 'midday' }, NOW);
    assert.strictEqual(tooSoon.ok, true, 'exactly MIN_LEAD_MS ahead must be allowed');

    const oneMinuteLater = SCHED.validateScheduleRequest(
        { dateStr: '2026-09-11', windowId: 'midday' }, NOW + 60000);
    assert.strictEqual(oneMinuteLater.ok, false);
    assert.match(oneMinuteLater.reason, /two hours/i);
});

t('a slot beyond the booking horizon is refused', () => {
    const far = SCHED.accraDateString(NOW + (SCHED.MAX_HORIZON_DAYS + 2) * 86400000);
    const v = SCHED.validateScheduleRequest({ dateStr: far, windowId: 'morning' }, NOW);
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /days ahead/i);
});

t('the LAST selectable date is fully bookable, every window', () => {
    // The horizon is calendar days, not an exact 30x24h span. Measured in
    // milliseconds, the final date is only partly bookable — the customer is
    // offered a day whose later windows are greyed out for a reason they cannot
    // act on. Checked at an afternoon "now", which is when that used to bite.
    const afternoonNow = Date.parse('2026-09-11T13:30:00Z');
    const last = SCHED.latestSelectableDate(afternoonNow);
    for (const w of SCHED.availableWindowsFor(last, afternoonNow)) {
        assert.strictEqual(w.available, true, `${last}/${w.id} should be bookable`);
    }
    // And the day after it is not.
    const past = SCHED.accraDateString(Date.parse(last + 'T12:00:00Z') + 86400000);
    assert.strictEqual(
        SCHED.validateScheduleRequest({ dateStr: past, windowId: 'morning' }, afternoonNow).ok, false);
});

t('a missing or unknown window is refused, never defaulted', () => {
    assert.strictEqual(SCHED.validateScheduleRequest({ dateStr: '2026-09-19' }, NOW).ok, false);
    assert.strictEqual(SCHED.validateScheduleRequest({ dateStr: '2026-09-19', windowId: 'brunch' }, NOW).ok, false);
    assert.strictEqual(SCHED.validateScheduleRequest(undefined, NOW).ok, false);
});

t('the picker never offers a slot the validator would refuse', () => {
    // This is the invariant that keeps the browser and createInspectionBooking
    // from disagreeing: both ask the same function.
    for (const dateStr of ['2026-09-11', '2026-09-12', '2026-09-19']) {
        for (const w of SCHED.availableWindowsFor(dateStr, NOW)) {
            const v = SCHED.validateScheduleRequest({ dateStr, windowId: w.id }, NOW);
            assert.strictEqual(w.available, v.ok,
                `${dateStr}/${w.id}: picker says ${w.available}, validator says ${v.ok}`);
        }
    }
});

t('an unavailable window carries the reason, not just a disabled flag', () => {
    const morning = SCHED.availableWindowsFor('2026-09-11', NOW).find(w => w.id === 'morning');
    assert.strictEqual(morning.available, false);
    assert.ok(morning.reason && morning.reason.length > 10);
});

t('the selectable date range starts today and ends at the horizon', () => {
    assert.strictEqual(SCHED.earliestSelectableDate(NOW), '2026-09-11');
    assert.strictEqual(SCHED.latestSelectableDate(NOW),
        SCHED.accraDateString(NOW + SCHED.MAX_HORIZON_DAYS * 86400000));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 4. ACCEPTANCE IS NOT COMMENCEMENT ────────────────────────────');

t('committing to Saturday does not authorise setting out on Friday', () => {
    const g = SCHED.canStartWork(scheduled(), NOW);
    assert.strictEqual(g.allowed, false);
    assert.match(g.reason, /Sat 19 Sep/);
});

t('work opens exactly EARLY_START_GRACE_MS before the window', () => {
    const opens = SAT_2PM - SCHED.EARLY_START_GRACE_MS;
    assert.strictEqual(SCHED.canStartWork(scheduled(), opens - 1).allowed, false);
    assert.strictEqual(SCHED.canStartWork(scheduled(), opens).allowed, true);
});

t('an appointment already underway stays startable', () => {
    assert.strictEqual(SCHED.canStartWork(scheduled(), SAT_2PM + 3600000).allowed, true);
});

t('a missed appointment does not lock the artisan out', () => {
    // Running late is not a reason to make the job impossible to do.
    const late = SAT_2PM + 5 * 86400000;
    assert.strictEqual(SCHED.canStartWork(scheduled(), late).allowed, true);
    assert.strictEqual(SCHED.resolveSchedule(scheduled(), late).isPast, true);
});

t('the artisan is told WHEN they may set out, not just that they may not', () => {
    const g = SCHED.canStartWork(scheduled(), NOW);
    assert.match(g.reason, /set out from/i);
    assert.strictEqual(g.opensAtMs, SAT_2PM - SCHED.EARLY_START_GRACE_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 5. The UI never offers an action the server would refuse ─────');

t('"Mark En Route" is withheld before the slot, on the inspection track', () => {
    const b = scheduled({ status: 'inspection_scheduled', calloutPaid: true });
    const sch = SCHED.resolveSchedule(b, NOW);
    const ids = META.getAllowedActions(b, 'artisan', { schedule: sch }).map(a => a.id);
    assert.ok(!ids.includes('en_route'), 'en_route must not be offered before the window');
    assert.ok(ids.includes('scheduled'), 'the appointment must be stated instead');
});

t('"Mark En Route" IS offered once the window opens', () => {
    const b = scheduled({ status: 'inspection_scheduled', calloutPaid: true });
    const opens = SAT_2PM - SCHED.EARLY_START_GRACE_MS;
    const ids = META.getAllowedActions(b, 'artisan', { schedule: SCHED.resolveSchedule(b, opens) })
        .map(a => a.id);
    assert.ok(ids.includes('en_route'));
    assert.ok(!ids.includes('scheduled'));
});

t('"Complete Inspection" is NEVER gated — a visit that happened can be recorded', () => {
    const b = scheduled({ status: 'inspection_scheduled', calloutPaid: true });
    const ids = META.getAllowedActions(b, 'artisan', { schedule: SCHED.resolveSchedule(b, NOW) })
        .map(a => a.id);
    assert.ok(ids.includes('complete_inspection'));
});

t('the work track gates en_route the same way', () => {
    const b = scheduled({ status: 'accepted', track: 'standard', quoteApproved: true });
    const early = META.getAllowedActions(b, 'artisan', { schedule: SCHED.resolveSchedule(b, NOW) })
        .map(a => a.id);
    assert.ok(!early.includes('en_route'));

    const late = META.getAllowedActions(b, 'artisan',
        { schedule: SCHED.resolveSchedule(b, SAT_2PM) }).map(a => a.id);
    assert.ok(late.includes('en_route'));
});

t('arriving and finishing are never gated by the clock', () => {
    for (const [status, id] of [['en_route', 'arrived'], ['in_progress', 'job_done']]) {
        const b = scheduled({ status, track: 'standard', quoteApproved: true });
        const ids = META.getAllowedActions(b, 'artisan', { schedule: SCHED.resolveSchedule(b, NOW) })
            .map(a => a.id);
        assert.ok(ids.includes(id), `${status} must still offer ${id}`);
    }
});

t('an UNSCHEDULED booking offers exactly what it always did', () => {
    // The regression guard for every booking that predates scheduling.
    const b = immediate({ status: 'inspection_scheduled', calloutPaid: true });
    const withOpts = META.getAllowedActions(b, 'artisan', { schedule: SCHED.resolveSchedule(b, NOW) });
    const without  = META.getAllowedActions(b, 'artisan');
    assert.deepStrictEqual(withOpts.map(a => a.id), without.map(a => a.id));
    assert.ok(without.map(a => a.id).includes('en_route'));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 6. What the two sides are TOLD ───────────────────────────────');

t('"accepted" reads as a commitment, not a summons, before the slot', () => {
    const b = scheduled({ status: 'accepted', track: 'standard' });
    const d = META.describe(b, 'artisan', { schedule: SCHED.resolveSchedule(b, NOW) });
    assert.strictEqual(d.awaitingSlot, true);
    assert.ok(!/head to their location/i.test(d.description),
        'the artisan must not be told to travel days early');
    assert.match(d.description, /Sat 19 Sep/);
});

t('the customer is told when their professional is coming', () => {
    const b = scheduled({ status: 'accepted', track: 'standard' });
    const d = META.describe(b, 'customer', { schedule: SCHED.resolveSchedule(b, NOW) });
    assert.match(d.description, /Sat 19 Sep/);
});

t('an unpaid callout still outranks the appointment — money first', () => {
    // "Pay visit fee" is the customer's blocking action. A schedule must not
    // bury it behind a calm "your visit is booked".
    const b = scheduled({ status: 'accepted', track: 'inspection', calloutPaid: false });
    const d = META.describe(b, 'customer', { schedule: SCHED.resolveSchedule(b, NOW) });
    assert.strictEqual(d.label, 'Pay visit fee');
});

t('once the slot arrives the copy returns to the normal lifecycle', () => {
    const b = scheduled({ status: 'accepted', track: 'standard' });
    const d = META.describe(b, 'artisan', { schedule: SCHED.resolveSchedule(b, SAT_2PM) });
    assert.strictEqual(d.awaitingSlot, false);
    assert.match(d.description, /head to their location/i);
});

t('describe() without a schedule is byte-for-byte what it always was', () => {
    const b = immediate({ status: 'accepted', track: 'standard' });
    assert.deepStrictEqual(META.describe(b, 'artisan'), META.describe(b, 'artisan', {}));
    assert.strictEqual(META.describe(b, 'artisan').awaitingSlot, false);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 7. The three-way pin (module / functions mirror / rules) ─────');

t('the Cloud Functions mirror is generated and in sync', () => {
    const gen = fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'bookingSchedule.js'), 'utf8');
    assert.match(gen, /GENERATED FILE — DO NOT EDIT/);
    // eslint-disable-next-line global-require
    const mirror = require(path.join(ROOT, 'functions', 'shared', 'bookingSchedule.js'));
    assert.strictEqual(mirror.EARLY_START_GRACE_MS, SCHED.EARLY_START_GRACE_MS);
    assert.strictEqual(mirror.MIN_LEAD_MS,          SCHED.MIN_LEAD_MS);
    assert.strictEqual(mirror.MAX_HORIZON_DAYS,     SCHED.MAX_HORIZON_DAYS);
    assert.strictEqual(mirror.REMINDER_LEAD_MS,     SCHED.REMINDER_LEAD_MS);
});

t('the mirror and the module agree on a real decision, not just constants', () => {
    // eslint-disable-next-line global-require
    const mirror = require(path.join(ROOT, 'functions', 'shared', 'bookingSchedule.js'));
    const req = { dateStr: '2026-09-19', windowId: 'afternoon' };
    assert.deepStrictEqual(
        mirror.validateScheduleRequest(req, NOW),
        SCHED.validateScheduleRequest(req, NOW));
    assert.deepStrictEqual(
        mirror.canStartWork(scheduled(), NOW),
        SCHED.canStartWork(scheduled(), NOW));
});

t('firestore.rules gates en_route on the SAME grace period', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const fn = /function scheduleWindowOpen\(\)\s*\{([\s\S]*?)\n    \}/.exec(rules);
    assert.ok(fn, 'scheduleWindowOpen() must exist — it is the server-side gate');
    assert.ok(fn[1].includes(String(SCHED.EARLY_START_GRACE_MS)),
        `rules must use ${SCHED.EARLY_START_GRACE_MS} ms`);
    assert.ok(fn[1].includes('scheduledForMs'));
    // Absence must pass: an immediate booking cannot be blocked by the gate.
    assert.ok(/!\('scheduledForMs' in existing\(\)\)/.test(fn[1]));
});

t('the appointment fields are server-only — a client cannot move its own gate', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const list = /function bookingSystemFields\(\)\s*\{([\s\S]*?)\n    \}/.exec(rules);
    assert.ok(list);
    for (const f of ['scheduledFor', 'scheduledForMs', 'scheduleWindowMins', 'scheduleReminderSentAt']) {
        assert.ok(list[1].includes(`'${f}'`), `${f} must be a system-authoritative field`);
    }
});

t('BOTH en_route clauses in the rules carry the gate', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    // The inspection track and the work track reach en_route by different
    // clauses. A gate on only one of them is a hole.
    const clauses = rules.split('scheduleWindowOpen()').length - 1;
    assert.ok(clauses >= 3,
        `expected the definition plus both en_route clauses, found ${clauses} references`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 8. Dispatch urgency is tiered, not binary ────────────────────');

t('dispatch has a distinct timeout for booked appointments', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'dispatch.js'), 'utf8');
    assert.match(src, /const SCHEDULED_TIMEOUT_S\s*=/);
    const emergency = /const EMERGENCY_TIMEOUT_S\s*=\s*([^;]+);/.exec(src);
    const standard  = /const STANDARD_TIMEOUT_S\s*=\s*([^;]+);/.exec(src);
    const sched     = /const SCHEDULED_TIMEOUT_S\s*=\s*([^;]+);/.exec(src);
    // eslint-disable-next-line no-eval
    const [e, st, sc] = [emergency, standard, sched].map(m => eval(m[1]));
    assert.ok(e < st, 'emergency must be the most urgent');
    assert.ok(st < sc, 'a booked appointment must be the least urgent');
});

t('dispatch no longer tells artisans they have "3 hours"', () => {
    // STANDARD_TIMEOUT_S became 3 minutes; the notification kept saying 3 hours.
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'dispatch.js'), 'utf8');
    assert.ok(!/'3 hours'/.test(src), 'the stale 3-hour promise must be gone');
});

t('the artisan notification names the appointment', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'dispatch.js'), 'utf8');
    assert.match(src, /appointment\.scheduled/);
    assert.match(src, /New Scheduled Booking/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('── 9. Scheduling does not break the timeout sweeps ──────────────');

t('the stale-inspection sweeps measure from the appointment, not from payment', () => {
    // A customer booking 10 days out and paying today would otherwise have the
    // booking auto-cancelled and refunded on day three.
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'pricing.js'), 'utf8');
    assert.match(src, /afterAppointment:\s*true/);
    assert.match(src, /appt\.endMs \+ STALE_INSPECTION_HRS/);
    const flagged = (src.match(/afterAppointment:\s*true/g) || []).length;
    assert.strictEqual(flagged, 2,
        'both calloutPaidAt-based sweeps must be appointment-aware');
});

t('appointment reminders are idempotent by construction', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'pricing.js'), 'utf8');
    assert.match(src, /scheduleReminderSentAt/);
    // The claim must happen inside a transaction, or two overlapping sweeps
    // double-notify.
    const fn = /async function sendAppointmentReminders[\s\S]*?\n}/.exec(src);
    assert.ok(fn, 'sendAppointmentReminders must exist');
    assert.match(fn[0], /runTransaction/);
    assert.match(fn[0], /if \(b\.scheduleReminderSentAt\) continue;/);
});

t('createInspectionBooking re-validates the appointment rather than trusting it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'pricing.js'), 'utf8');
    assert.match(src, /bookingSchedule\.validateScheduleRequest\(scheduleReq, Date\.now\(\)\)/);
    // Both fields written together — one without the other could pass a gate.
    assert.match(src, /scheduledForMs:\s*scheduleStartMs/);
    assert.match(src, /scheduleWindowMins:\s*scheduleWindowMins/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nbooking-schedule: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
