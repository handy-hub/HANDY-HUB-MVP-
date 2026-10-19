# Scheduled bookings — "now" vs "Saturday at two"

Investigated and implemented 2026-09-12.

---

## The finding

The suspicion was that normal bookings were being routed through the emergency
booking machinery. **Partially true — and the cause is the inverse.**

The two flows do not share code. `book-emergency.html` writes `bookings/{ref}`
directly with a pre-matched `artisanId`; `book-request.html` calls the
`createInspectionBooking` Cloud Function and is dispatched by radius matching.
They are separate paths.

They behaved identically because **neither had any concept of a future
appointment.** There was no date/time picker anywhere in the shipped customer
app — `book-request.html` asked *what needs fixing · describe · photos · where*,
and never *when*. The picker lived in `book-step3.html`, deleted in the
2026-07-02 fresh start, and had only ever written to `localStorage`.

With no booking carrying a time, "now" was the only behaviour the system could
express.

### The three dead rails

| Field | State before this work |
|---|---|
| `scheduledAt` | Documented in `bookingRepository.js` as "ISO timestamp of the appointment". **Never written by any code** — the only value it ever held was the literal `null` from `book-emergency.html`. Four surfaces read it and rendered "No date set" forever. |
| `scheduledFor` | Accepted, validated and persisted by `createInspectionBooking`; projected by `resolveJobBrief`; rendered by artisan `job.html`. **No caller ever passed one.** |
| Dispatch timing | `onBookingCreated` dispatched on creation, unconditionally. `STANDARD_TIMEOUT_S = 3 minutes`, while the notification text still promised "3 hours". |

And the collapse the symptom actually named: `accepted` flowed straight into
`en_route` with nothing between them. **Acceptance and commencement were the
same event.**

---

## The model

`track` answers *which commercial lifecycle* (inspection / emergency /
standard). It does not answer *when*. That is a separate, orthogonal question,
so it lives in a separate field rather than a fourth track — a scheduled
inspection is still an inspection, with the same callout fee, quote and escrow.

```
scheduledForMs == null   →  IMMEDIATE.     "Come as soon as someone can."
scheduledForMs  > 0      →  APPOINTMENT.   "Come in this window."
```

**Absence means immediate.** Every booking written before this work, and every
emergency booking forever, classifies correctly with no migration and no
backfill.

### Assign now, serve later

Dispatch still runs immediately for a scheduled booking. The alternative —
deferring dispatch until near the appointment — was rejected because:

- the callout fee is only payable *after* an artisan accepts, so deferring leaves
  the booking unfunded and uncommitted for days;
- the customer would hear nothing at all between booking and the day;
- `STALE_INSPECTION_HRS = 72` already presumes a gap between "paid" and
  "inspected". Scheduling makes that gap intentional rather than accidental.

So a scheduled booking is dispatched as an **appointment, not a summons**: the
artisan is asked "can you take this on Sat 20 Sep, 2–5pm?", and accepting means
"I commit to that window" — not "I am on my way".

---

## Where the authority lives

`shared/js/domain/bookingSchedule.js` is the single source of truth. It has no
imports, so it evaluates in the customer app, the artisan app, the Cloud
Functions runtime and the Node test suite alike.

Three consumers must agree, or a customer is offered a slot the server refuses:

| Consumer | How it gets the rules |
|---|---|
| Browser (the picker) | imports the ES module directly |
| Cloud Functions | `functions/shared/bookingSchedule.js` — **generated**, never edited, by `scripts/build-functions-shared.cjs` (`functions.source: "functions"` means `../shared` is not uploaded) |
| `firestore.rules` | cannot import anything, so `scheduleWindowOpen()` hardcodes the grace period as a literal |

`npm run lint:shared` pins all three: it fails if the generated mirror is stale
*or* if the rules literal has drifted from `EARLY_START_GRACE_MS`.

### Time is absolute, wall clock is Ghanaian

A customer picks a wall clock ("Saturday, 2pm"). `new Date('2026-09-20T14:00')`
would parse that in the *device's* timezone, so a phone set to London books an
hour off what the artisan is told. The wall clock is therefore interpreted
explicitly in Africa/Accra (`ACCRA_UTC_OFFSET_MINUTES = 0` — Ghana is UTC+0 all
year, no DST) and stored as an absolute instant.

`scheduledForMs` (epoch ms) is stored alongside the ISO string because Firestore
Rules cannot parse ISO-8601. Both are written in one operation — a booking
carrying one without the other could pass a gate it should not.

---

## Acceptance is not commencement

The gate, in three layers:

1. **`firestore.rules` — `scheduleWindowOpen()`.** The one that actually
   enforces it. Applied to *both* `en_route` clauses (work track and inspection
   track); a gate on only one is a hole. Absence of `scheduledForMs` passes
   unconditionally.
2. **`bookingActions.js` — `scheduleGated: true` on `ACTION.EN_ROUTE`.** So the
   artisan gets a sentence naming the appointment instead of a permission error.
3. **`bookingStatusMeta.getAllowedActions()`.** So the button is never offered.

Opens **90 minutes** before the window (`EARLY_START_GRACE_MS`) — generous enough
for an artisan leaving early to beat Accra traffic, tight enough that "Mark En
Route" on Monday for a Saturday job is refused.

Only *setting out* is gated. **Arriving, finishing and completing an inspection
are never gated** — they record things that already happened, and a job someone
is standing in front of must always be recordable.

---

## Freshness and money

Nothing about scheduling touches the financial trust boundary. The callout fee,
escrow, quote and settlement paths are unchanged. Two adjustments were needed so
scheduling does not *break* them:

- **`afterAppointment` on the two `calloutPaidAt` sweeps.** Those measure "has the
  artisan had long enough?" from payment. A customer booking ten days out and
  paying today would otherwise have the booking auto-cancelled and refunded on
  day three. For a scheduled booking the clock now starts when the window closes.
- **Appointment reminders** ride `checkBookingTimeouts` (already deployed) rather
  than adding a second Cloud Run service against the `maxInstances: 1` binding.
  Idempotent via `scheduleReminderSentAt`, claimed inside a transaction.

`scheduledFor`, `scheduledForMs`, `scheduleWindowMins` and
`scheduleReminderSentAt` are all in `bookingSystemFields()` — **server-only**. A
customer who could write `scheduledForMs` could move their own gate into the
past; an artisan could rewrite the slot they committed to.

---

## The two journeys, side by side

**Emergency** — customer picks an artisan and taps. Booking written client-side
with `type: 'emergency'`, `artisanId` set, no schedule. `onBookingCreated` stamps
`track: 'emergency'`, server-prices the callout, skips dispatch (pre-matched).
Artisan has ~1 minute. Accept → escrow held → they travel now.

**Scheduled** — customer picks a category, describes the problem, **chooses a
date and an arrival window**, confirms the fee. `createInspectionBooking`
re-validates the wall clock and writes the appointment. Dispatch runs
immediately with a 20-minute response window and a notification naming the slot.
Accept → commitment, *not* travel. Customer pays the callout to secure it.
Nothing moves until 90 minutes before the window, when `en_route` unlocks in all
three layers at once. A reminder goes to both parties two hours before.

**Immediate (the default)** — identical to scheduled except the customer leaves
"As soon as possible" selected, no appointment is written, and every gate above
passes unconditionally. This is exactly the behaviour HandyHub had before.

---

## Tests

- `npm run test:booking-schedule` — 48 tests: absence-means-now, Accra wall clock,
  horizon and lead-time rules, the gate and its boundaries, what each side is
  told, and the three-way pin.
- `npm run test:booking-actions` — 8 added for the transition-layer gate.
- `npm run test:rules` — 8 added, proven against the emulator: neither party can
  write the appointment, neither `en_route` clause opens early, and an
  unscheduled booking is never gated.
- `npm run lint:shared` — the generated mirror and the rules literal.

## Still owed

- A **reschedule** path. Today the answer is cancel + rebook, which settles the
  callout through the existing fair-settlement rules. A real reschedule would
  need its own Cloud Function (the fields are server-locked).
- **Artisan availability** is not consulted. An artisan can be offered two
  overlapping windows; dispatch ranks on proximity and rating, not on a calendar.
- The functions and rules changes need a **deploy** to take effect.
