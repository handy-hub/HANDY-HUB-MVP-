# Booking Engine — Reconstruction Plan

> **Status:** Architecture plan. **Zero code deleted.** This is the controlled,
> strangler-fig path from the current 4-page flow to a single state-driven
> Booking Host Shell — built *alongside* the working pages, cut over only at
> proven feature parity. The app stays operational the entire time.
>
> Author context: HandyHub MVP (static HTML + Firebase, client-side). Grounded
> in the real codebase as of branch `CUSTOMER-APP`, 2026-06-28.

---

## 0. Reality check — what this codebase actually is

The reconstruction prompt assumes a React/SPA app (routes, reducers, hooks).
**This codebase is not that.** Getting the plan right means naming the real stack:

- Booking is **4 static HTML pages**: `book-step1.html` → `book-step4.html`
  (plus `book-now.html`, `book-emergency.html`, `booking.html` = "My Requests").
- **State already flows through ONE key**: every step reads/writes
  `localStorage[HH_State.scopedKey('hh_booking')]` — **47 references across 16
  files**. There is no reducer to delete; the single source of truth *already
  exists as data*, it just has no controller enforcing transitions.
- **A shared `stateService.js`** is already loaded (`book-step4.html:6`).
- **Routing IS the state machine today** — `window.location.href='book-stepN.html'`
  is the only "transition." This is the core defect the prompt correctly names:
  *routing is being misused as state management.*
- Design tokens are centralized in `shared/css/ui-polish.css` +
  `customer-app/css/booking-flow.css` (`--ui-primary`, `--bf-*`).
  **Hard rule (Silas): no hardcoded colors — always reference root tokens.**

**Implication:** the migration is *lighter* than the prompt assumes for state
(it's already centralized) and *heavier* than assumed for coupling (booking is
the app's spine — see §2). Plan accordingly.

---

## 1. Diagnosis — legacy multi-page state chain

Each `book-stepN.html` behaves as an **independent application**, not a state
transition:

| Symptom | Evidence in code |
|---|---|
| Routing misused as state | Transitions are `location.href='book-step3.html'`; the URL *is* the state pointer. |
| Layout re-declared per step | Each page re-renders `.bk-header`, `.bk-stepper`, footer — and they **drifted**: step1 footer ≠ step2 `.bk-footer-step2` ≠ step3 `.bk-footer-step3`. |
| Logic duplicated | `_bkKey()` / `getState()` / `setState()` redefined inline in every step. |
| Context re-built each load | The artisan "hero" appears as a *different component* per step (banner → `.pro-card` → `.pro-mini-card`). |
| Styling drift | step2 injected hardcoded `.pro-card` CSS via JS (now fixed); step3 has its own inline `<style>`. |

**Root cause is architectural, not visual:** there is no Booking *Host* — only
four hosts that each rebuild the world. Fixing CSS alone (Move 1, done) makes it
*look* unified; only a host shell makes it *be* unified.

---

## 2. Blast radius — why "delete then rebuild" was rejected

Booking is **not an isolated domain**. Deleting the pages breaks **78
references across 22 files**:

- **`dashboard.html` — 12 refs**: quick chips, "View All", emergency, "My
  Requests", resume-in-progress logic. The primary funnel.
- **Downstream of booking**: `quote-approval.html` (5), `review.html` (4),
  `live-tracking.html`, `js/pages/trackingPage.js` — these act on bookings.
- **Discovery/entry surfaces**: `saved.html` (5), `professionals.html`,
  `artisan-profile.html`, `service-detail.html`, `js/nearbyPros.js`,
  `js/adBanner.js`, `js/quoteModalService.js`, `js/authInit.js`.
- **Financial**: booking writes the documents wallet/escrow/tracking read.
  Touching this engages the "5 invariants that must never break" (security
  audit record) and the financial trust boundary.

This is *why* the strategy is strangler-fig: you replace a spine vertebra by
vertebra while the body keeps working. You never amputate it.

---

## 3. Target end-state — Booking Engine as a state machine

Booking becomes **one persistent session** rendered inside **one shell**. The
"steps" become **states**, not pages:

```
SERVICE_SELECTION  →  PROFESSIONAL_SELECTION  →  SCHEDULE  →
PRICING_QUOTE  →  CONFIRMATION  →  COMPLETION
```

(Six states — note your current flow folds Professional + Schedule oddly across
step2/step3; the state machine is the chance to make that honest.)

- These are **states rendered inside a `booking-host.html` shell**, not separate
  documents.
- **URL MAY reflect state** (`booking-host.html#schedule`) for deep-link/back-
  button support, but **must not control logic** — the controller is the source
  of truth; the hash is a projection of it.

---

## 4. The Booking Host Shell — the one persistent container

A single `booking-host.html` (or an enhanced `booking.html`) that is the **only**
booking UI container. Structure that **never re-renders between states**:

```
┌─────────────────────────────────────────┐
│  PERSISTENT HEADER (hero object)         │  ← .bk-anchor (already built)
│  ⚡ Fix Switch · GHC 50                   │     service + pro identity,
│  👤 Kwame A. ★4.9                         │     always visible
├─────────────────────────────────────────┤
│  UNIFIED PROGRESS INDICATOR              │  ← .bk-stepper, driven by
│  ●──●──○──○  (state-driven)              │     controller.state, NOT page
├─────────────────────────────────────────┤
│                                          │
│  STATE RENDERER AREA                     │  ← only THIS swaps per state
│  (service list / schedule / quote / …)   │
│                                          │
├─────────────────────────────────────────┤
│  STABLE ACTION ZONE                      │  ← .bk-cta-btn, one CTA system
│  [ Continue → ]                          │     (already canonical)
└─────────────────────────────────────────┘
```

**Reuses what Move 1 already produced:** `.bk-anchor` (the hero), the canonical
`.bk-cta-btn`, `.bk-stepper`, all token-based. The shell is the *home* those
shared components were always meant to live in.

**Enforcement rule:** header / progress / action zone are rendered **once** on
shell load. State transitions touch **only** the State Renderer Area. If a
transition re-renders the header, the architecture has regressed to page-based.

---

## 5. State management layer — the Booking Controller

A new `shared/js/booking/bookingController.js`. Wraps the **already-existing**
`hh_booking` localStorage object with transition discipline. Responsibilities:

1. **Track current state** (`controller.state`, one of the 6).
2. **Hold the Booking Session Object** (§7) — reads/writes the existing
   `hh_booking` key via `HH_State.scopedKey` (no new storage; same key,
   migration-safe).
3. **Manage transitions** — `controller.next()` / `goTo(state)` — replacing all
   `location.href='book-stepN.html'` calls.
4. **Validate transitions** — cannot enter SCHEDULE without a service; cannot
   enter CONFIRMATION without a professional + schedule. (Today these checks are
   scattered as `if (!state.schedule) showToast(...)` inside each page.)
5. **Emit a render signal** — the shell subscribes and re-renders *only* the
   State Renderer Area.

> **Routing is no longer the source of truth; the controller is.** The URL hash,
> if used, is written *by* the controller, never read *as* authority.

---

## 6. Migration strategy — strangler-fig, 6 phases, never broken

This is the part that keeps the app alive. **No phase deletes a working page.**

### Phase 1 — Parallel Layer Introduction
Create `booking-host.html` + `bookingController.js` **alongside** the existing
pages. Old pages untouched and fully functional. Shell renders nothing real yet
— scaffold only. *Reversible: delete two new files.*

### Phase 2 — State Mirroring
Port each step's **content** (not its chrome) into a state renderer module:
- `book-step1` body → `SERVICE_SELECTION` renderer
- `book-step2` body → `PROFESSIONAL_SELECTION` renderer
- `book-step3` body → `SCHEDULE` + `PRICING_QUOTE` renderers
- `book-step4` body → `CONFIRMATION` / `COMPLETION` renderer

Each renderer **consumes controller state** and is **step-agnostic** (§8). The
`SVC_CATALOG`, promo logic, artisan-load-from-Firestore, schedule modal, wallet
balance read — all move in as-is; they already read `hh_booking`.

### Phase 3 — Gradual Routing Redirection
Point **one** entry point at the shell — recommend the dashboard "View All"
(`dashboard.html:565`) or a single quick-chip. Everything else still uses old
pages. Test the new path in production-like conditions with a real account.

### Phase 4 — Feature Parity Validation
Checklist — **no cutover until every box is checked** (§9). Includes the
financial path: booking still writes the same documents, escrow/wallet still
debit correctly, tracking still picks up the booking.

### Phase 5 — Legacy Isolation
Once parity holds, repoint the remaining entry points (the 22-file map in §2 is
your checklist). Old `book-step*.html` stay on disk but are no longer linked.
Add a deprecation banner/comment. *Still reversible: repoint links back.*

### Phase 6 — Full Cutover
All booking entry points resolve into the shell. Old pages can now be deleted in
a **separate, dedicated PR** — at which point deletion is safe because nothing
links to them and parity is proven. (This is the *only* point the original
"delete it all" instruction becomes safe.)

---

## 7. Data architecture — the Booking Session Object

Already exists as `hh_booking`; this **formalizes its shape** (don't invent a new
store — document and validate the real one):

```js
// localStorage[HH_State.scopedKey('hh_booking')]
{
  state: 'SCHEDULE',                 // NEW: current state pointer (controller-owned)
  services: [{ name, desc, price, category, duration }],
  category, totalMin, totalMax,
  serviceFee, serviceCharge, platformFee, total,
  professional: { id, uid, name, type, rating, photo, ... },
  preselectedArtisan: { ... },       // professional-first entry
  schedule: { date, dateDisplay, dateShort, time },
  address,
  promoCode, promoDiscount, promoType,
  notes, payment,
  _validation: { canSchedule, canConfirm }   // NEW: transition flags
}
```

Replaces: scattered inline `getState()`/`setState()`, sessionStorage hops
(`hh_booking_intent`, `hh_selected_artisan`, `hh_service`), and page-level vars.
The controller becomes the *only* writer; renderers read.

---

## 8. Component system refactor — consume state, never assume step

Normalize per-step fragments into system modules that take state and render —
**none may know "which step" they're in:**

| Module | Replaces | Status |
|---|---|---|
| Service/Artisan identity (hero) | step1 banner, step2 `.pro-card` header, step3 `.pro-mini-card` | **`.bk-anchor` already built** ✅ |
| Progress indicator | three drifted `.bk-stepper` copies | exists; make state-driven |
| Pricing module | step3 `.price-table-card` + footers | extract, configurable |
| Schedule picker | step3 `.sched-modal` | already stateful; make reusable |
| Primary CTA | `.btn-continue`, `.btn-continue-full`, `.btn-confirm` | **canonical `.bk-cta-btn` already built** ✅ |
| Trust/verification | step2 `.verify-banner`, step3 `.trust-row` | make persistent |

Two of six are already done from the Move 1 session.

---

## 9. Feature-parity checklist (gate for Phase 4 → 6)

- [ ] Service search + category select + multi-select + price range
- [ ] Promo codes apply and persist
- [ ] Professional-first entry (from artisan profile) pre-selects + pins pro
- [ ] Firestore artisan load + filters (recommended/rating/price) + empty/error states
- [ ] Schedule modal (date min, time slots) writes schedule
- [ ] Wallet balance read + payment selection
- [ ] **Booking writes the same Firestore documents** (financial invariant)
- [ ] **Escrow/wallet debit unchanged** (cross-check security audit record)
- [ ] Confirmation screen + booking ID + share
- [ ] Tracking / quote-approval / review still resolve from a new-shell booking
- [ ] Back button + deep-link behave (URL-hash projection)
- [ ] Dark mode intact across all states

---

## 10. UX continuity rules (non-negotiable)

1. Service/artisan identity (hero) **visible at all times** — via persistent `.bk-anchor`.
2. Layout structure **never changes** between states — only the renderer area swaps.
3. Transitions feel like **state updates, not page loads** — no full reload, no flash.
4. No state "resets" visual context.
5. User always feels inside **one continuous transaction**.

---

## 11. Risks, trade-offs, alternatives

**Strengths:** maintainability, true UX continuity, scales to new services,
enables real-time (availability/dynamic pricing), kills duplication.

**Risks:**
- Migration must not break the live financial flow → mitigated by strangler-fig
  + the §9 gate + git per phase.
- State-machine discipline required → mitigated by "controller is sole writer."
- Risk of reintroducing page logic → enforced by "transitions touch only the
  renderer area."
- **HandyHub-specific:** booking feeds escrow/wallet — every phase must re-verify
  the financial invariants, not just the UI.

**Alternatives considered:**
1. *Shared layout shell over the existing pages* — lower effort, weaker long-term.
   (This is essentially Move 1 — already partly done; good but not the end-state.)
2. *Hybrid: shared components, still route-based* — medium effort, partial fix.
3. **Full state-machine shell (recommended)** — best for a scaling marketplace.

---

## 12. Recommendation

Build a single **Booking Host Shell** powered by the **Booking Controller**
wrapping the *already-centralized* `hh_booking` object. Treat routing as optional
and secondary (URL hash = projection of state). Treat booking as one continuous
transaction. Migrate strangler-fig (§6) — never breaking the live flow, never
deleting a working page until parity is proven in Phase 6.

**End-state goal:** the booking system feels like one uninterrupted transaction
where only *information* changes, never *structure*.

---

### Immediate next steps (when you pick this up, fresh)
1. Resolve the open Move-1 bug first: trace why step-1 `.bk-search` /
   `.cat-icon-btn` / `.service-item` visual rules aren't landing. (A clean
   baseline makes Phase 2 mirroring trivial.)
2. Phase 1 scaffold: create `booking-host.html` + `bookingController.js`. Two new
   files, nothing touched. Fully reversible.
