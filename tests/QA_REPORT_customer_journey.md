# HandyHub Customer App — End-to-End QA Report

**Discipline:** Senior QA Automation / E2E Test Architecture
**Method:** Playwright (Chromium, iPhone-14 viewport, Accra geolocation), real authenticated session against **live Firebase**
**Account under test:** `testing@gmail.com` (real customer — profile "Obed Korda", Accra; 26 upcoming + 2 cancelled real bookings on record)
**Build:** branch `CUSTOMER-APP`, served from repo root (`localhost:8766`) which mirrors the production Firebase Hosting staging layout exactly (`build-customer-app/{customer-app,shared}/`), so path-resolution observations apply to production
**Date:** 2026-06-28
**Artifacts:** [tests/e2e_customer_journey.py](e2e_customer_journey.py) · [tests/e2e_results.json](e2e_results.json) · 33 transition screenshots in [tests/screenshots/e2e/](screenshots/e2e/)

> **Scope rule honoured:** Every conclusion below is from **observed runtime behavior** during automated interaction. Findings that turned out to be Firebase/3rd-party/test-harness noise were re-verified against source and reclassified or discarded — they are listed transparently in the "Triaged Out" section so nothing is hidden.

---

## 1. Executive Summary

| | |
|---|---|
| Pages exercised (authenticated) | **27** customer pages + 3 public |
| Logged actions | **82** (76 PASS · 3 FAIL · 3 WARN) |
| Confirmed defects | **1 HIGH · 3 MEDIUM · 2 LOW** |
| False positives caught & discarded | 1 HIGH ("applyFilter") + ~22 MEDIUM (Firebase App Check / Firestore-channel / 3rd-party CDN noise) |
| Core happy-path booking flow | **Functional** (entry → service → step1 → step4 confirmation with real crypto booking ID) |
| Financial integrity (observed at UI) | **Honest** — no fake credit, no premature "assigned", real escrow-aware copy |

**Verdict (detail in §6): `PARTIALLY STABLE — one screen functionally broken, core journey sound.`**

The customer journey from landing through booking confirmation works on real data, with genuinely honest UX (no fabricated confirmations, real booking IDs, real profile/history binding). One screen — **Saved** — is functionally dead due to a script-path bug, and the booking flow's middle steps cannot be *completed* end-to-end because **no artisans currently exist in range** (an honest empty state, not a code fault, but it blocks the pro-selection → schedule sub-flow).

---

## 2. Journey Walkthrough (chronological, as executed)

| Phase | Page(s) | Observed result |
|---|---|---|
| 0. Auth | `login.html` | ✅ Real Firebase login succeeded, redirected to dashboard in ~6.5 s. Fields present; client validation present. |
| 1. Home / Discovery | `dashboard.html` | ✅ Real profile bound (**"Obed Korda", "Accra"** — not the "Kwame Mensah" placeholder). 8 service tiles, rotating ad banner, bottom nav (5), sidebar open/close, search navigates to results. Nearby-pros shows honest **"No professionals found"** empty state. |
| 2. Service select | dashboard → `service-detail` → `book-step1` | ✅ Tapping "Plumber" routed into the booking flow. |
| 3. Book Step 1 (Service) | `book-step1.html` | ✅ 8 categories, 4 service rows rendered; selecting a service + Continue advanced to Step 2. |
| 4. Book Step 2 (Professional) | `book-step2.html` | ⚠️ Loads cleanly; **filter pills (Recommended/Rating/Price) work**; but **0 professionals** to choose (empty DB in range) → the select-pro → step3 sub-flow cannot complete naturally. |
| 5. Book Step 3 (Schedule/Review) | `book-step3.html` | ⚠️ Price/service/payment summary render. **Schedule date fell back to hardcoded `Saturday, 25 May 2026`** because no slot was chosen on the degraded path (see M-1). |
| 6. Book Step 4 (Confirm) | `book-step4.html` | ✅ **Strong** — real crypto booking ID `HHB-260628-2104-52E5`, honest "Request Sent / Waiting for the artisan to accept", live Firestore status bar ("Searching for a professional…"). No fake "assigned". |
| 7. Emergency booking | `book-emergency.html` | ✅ **Integrity confirmed** — landed on honest `state-no-match` ("No professionals"), did **NOT** fake a "Professional on the way". Matches the Session-7 redesign intent. |
| 8. Post-job & account | bookings, live-tracking, review, topup, transactions, notifications, messages, saved, profile, settings (+3 sub-pages) | Mostly ✅ — see table §4. **`saved.html` is broken (H-1).** Bookings history shows **real counts** ("Upcoming 26", "Cancelled 2"), tabs switch. Review stars selectable. Topup presets work (real Paystack charge intentionally not triggered). |
| 9. Alternative paths | back-nav, empty/invalid login, unknown route, throttled network | ✅ Back button returns step2→step1. ✅ Empty login blocked with inline validation. ✅ Invalid email rejected client-side. Unknown route serves blank (L-2). Slow-network leaves skeletons up >5 s (soft, see L-1). |

---

## 3. Confirmed Defects (severity-ranked, all verified against source)

### 🔴 HIGH

**H-1 — `saved.html` is functionally dead: real-time data never loads (production-affecting)**
- **Observed:** Page loads but is **permanently stuck on skeleton placeholders** (screenshot `26_saved.png`); tabs read "Professionals 0 / Services 0"; `window._svUid` never set → the Firestore subscription never runs.
- **Root cause (verified):** Wrong relative import depth in the page's two scripts:
  - [customer-app/js/pages/savedPage.js:1-2](../customer-app/js/pages/savedPage.js#L1-L2) imports `../../shared/js/...` — from `customer-app/js/pages/` that resolves to `customer-app/shared/...` → **404**. Sibling files in the same folder correctly use `../../../shared/`.
  - [customer-app/js/savedHelpers.js:1](../customer-app/js/savedHelpers.js#L1) imports `../shared/js/...` — from `customer-app/js/` resolves to `customer-app/shared/...` → **404**. Should be `../../shared/`.
- **Runtime proof:** 404s observed for `customer-app/shared/js/utils/authGuard.js` and `customer-app/shared/js/app/container.js`; `_svUid = NOT SET`.
- **Production impact:** The Firebase staging mirror (`stage-hosting.cjs`) preserves the identical sibling layout, so these paths 404 in production too — **not a dev-only artifact.** The Saved feature, plus the `hhSaveProfessional` / `hhSaveService` helpers other pages rely on, are non-functional.
- **Repro:** Log in → open Saved (bottom nav) → observe skeletons never resolve.
- **Fix (test-observed scope):** `savedPage.js` → `../../../shared/`; `savedHelpers.js` → `../../shared/`.

### 🟠 MEDIUM

**M-1 — Book Step 3 schedule shows a stale hardcoded date on the no-slot path**
- **Observed:** `#sched3-date` displayed **"Saturday, 25 May 2026"** (a date in the past; today is 2026-06-28).
- **Root cause (verified):** [customer-app/book-step3.html:425](../customer-app/book-step3.html#L425) uses `state.schedule.dateDisplay || 'Saturday, 25 May 2026'`. The date IS computed when a slot is chosen, but the **fallback literal is a stale past date**. Reachable whenever a user lands on Step 3 without having set a slot.
- **Impact:** Confusing/incorrect default; undermines trust in the price/schedule summary. Cosmetic-functional.
- **Fix:** Replace the literal fallback with a computed default (e.g. next available slot / today) or force slot selection before Step 3.

**M-2 — Pro-selection sub-flow cannot complete (no artisans in DB / range)**
- **Observed:** `book-step2.html` renders cleanly but lists **0 professionals**; the natural select-pro → Step 3 transition is blocked. Dashboard "Nearby Professionals" likewise empty.
- **Assessment:** This is an **honest empty state**, not a code defect — but from a *user-journey* standpoint the standard booking flow is **not completable end-to-end** in the current data state. Confirmed elsewhere the backend is real (26 historical bookings exist), so this is a **data/seeding gap**, not broken logic. Flagged because it degrades the journey today.
- **Fix:** Seed verified artisans with GPS coordinates (long-standing pending item: "Artisan lat/lng schema"), or provide a graceful "no pros yet" CTA in the standard flow as the emergency flow already does.

**M-3 — `transaction-history.html` malformed inline SVG**
- **Observed:** Console error `<svg> attribute viewBox: Unexpected end of attribute. Expected number, " 0 24 24"` — a `viewBox` is truncated/malformed (likely a missing leading number, e.g. `viewBox=" 0 24 24"`).
- **Impact:** One icon renders incorrectly or as a blank box; page otherwise functions (real transaction data loads, tabs switch). Cosmetic.
- **Fix:** Correct the `viewBox` to `viewBox="0 0 24 24"` on the offending `<svg>` in transaction-history.html.

### 🟡 LOW

**L-1 — Degraded loading under throttled network**
- **Observed:** Under 800 ms-latency / 50 kbps throttle, dashboard left **~24 skeleton/loader elements** still visible after 5 s.
- **Assessment:** Soft — Firestore over a real slow link legitimately takes longer than the 5 s sample window; no spinner was *infinitely* stuck on normal network. No timeout/empty-state fallback observed for the skeletons, though.
- **Fix (optional):** Add a max-wait fallback that swaps skeletons for an empty/retry state if data hasn't arrived in N seconds.

**L-2 — Unknown route serves a blank page locally**
- **Observed:** `…/this-page-does-not-exist.html` rendered an empty document (title `''`) on the dev server. In production the Hosting rewrite (`** → login.html`) would catch this, so the blank is a **dev-server artifact**, but no client-side 404 page exists as a safety net.
- **Fix (optional):** Ship a `404.html` / client guard for robustness independent of hosting rewrites.

---

## 4. Per-Page Health Matrix (authenticated)

| Page | Loads | JS exceptions | Real data bound | Verdict |
|---|---|---|---|---|
| login | ✅ | 0 | n/a | ✅ Functional (client validation present) |
| dashboard | ✅ | 0 | ✅ name/loc/services/history | ✅ Functional |
| book-step1 | ✅ | 0 | ✅ categories+services | ✅ Functional |
| book-step2 | ✅ | 0 | ⚠️ empty pro list (M-2) | ⚠️ Blocked by data |
| book-step3 | ✅ | 0 | ⚠️ stale date fallback (M-1) | ⚠️ Partial |
| book-step4 | ✅ | 0 | ✅ crypto ID + live status | ✅ Functional |
| book-emergency | ✅ | 0 | ✅ honest no-match | ✅ Functional (integrity OK) |
| booking (history) | ✅ | 0 | ✅ real counts, tabs work | ✅ Functional |
| live-tracking | ✅ | 0 | ✅ loads | ✅ Functional |
| review | ✅ | 0 | ✅ stars selectable | ✅ Functional |
| topup | ✅ | 0 | ✅ presets (charge not triggered) | ✅ Functional |
| transaction-history | ✅ | 0 | ✅ real txns | ⚠️ M-3 SVG cosmetic |
| notification | ✅ | 0 | ✅ | ✅ Functional |
| messages | ✅ | 0 | ✅ | ✅ Functional |
| **saved** | ✅ | 0 | ❌ **subscription never runs** | 🔴 **H-1 BROKEN** |
| profile | ✅ | 0 | ✅ | ✅ Functional |
| settings (+ personal-info, notifications, security) | ✅ | 0 | ✅ | ✅ Functional |

*(JS exceptions = genuine page errors only; Firebase App-Check 400s and Firestore-channel aborts excluded as environment noise — see §5.)*

---

## 5. Triaged Out — what looked like bugs but is NOT (verified)

Transparency on every alarm the runner raised so nothing is silently dropped:

- **"`window.applyFilter is not a function`" (originally flagged HIGH on book-step3):** **FALSE POSITIVE.** On `book-step2.html` loaded directly, `applyFilter` is defined and **no pageerror fires**. The exception in the full run was a **test-harness timing artifact** — my script clicked Step-2 filter pills while the page was already navigating to Step 3. Discarded.
- **~22 × "Console error: Failed to load resource 401/400":** **Firebase App Check** (`content-firebaseappcheck.googleapis.com` returns 400 because the reCAPTCHA key isn't authorized for `localhost`) and **Firestore realtime `Listen/channel` aborts** on navigation/unload. Environment/expected, not page defects. Confirmed by capturing the real request URLs.
- **CDN/3rd-party request failures** (`images.unsplash.com`, `i.pinimg.com`, `nominatim`, `tile.openstreetmap`, `bigdatacloud`, `recaptcha/clr`, `csp.withgoogle.com`): blocked/aborted in headless; not app logic. (Note: the Unsplash/Pinterest avatars *are* placeholder stock imagery in pro-card templates — worth replacing for production polish, but not a functional break.)
- **`topup.html` "Framing google.com violates CSP (report-only)":** report-only Paystack/reCAPTCHA frame notice — informational, no action taken by the browser.

---

## 6. Production-Readiness Verdict

### `PARTIALLY STABLE`

**Why not "fundamentally broken":** The spine of the customer journey is real and honest. Login authenticates against live Firebase; the dashboard binds the actual user's name, location, service catalog and a real 26-booking history; the booking flow produces a genuine crypto booking ID and an honest "waiting for artisan" state driven by a live Firestore subscription; the emergency flow correctly refuses to fake a confirmation. Across 27 authenticated pages there were **zero genuine uncaught JS exceptions**. This is not a hardcoded mock-up — the financial/booking presentation layer is wired to a real backend.

**Why not "production-ready":**
1. **H-1** makes an entire navigable feature (Saved) silently dead in production — a user taps a bottom-nav tab and stares at skeletons forever. That is a shippable-blocker.
2. **M-2** means the *standard* booking flow cannot be carried to completion right now because no selectable artisans exist — the end-to-end "book a known pro" journey is unverifiable against live data until artisans are seeded with coordinates.
3. **M-1 / M-3** are trust-eroding cosmetic-functional defects on money-adjacent screens (a past-dated schedule default; a broken icon on the transactions page).

**Path to ready (test-observed scope only):** fix the two `saved` import paths (H-1), replace the stale Step-3 date fallback (M-1), correct the transaction-history `viewBox` (M-3), and seed verified artisans so the pro-selection sub-flow and Nearby Professionals can be exercised end-to-end (M-2). None of these require redesign or new features — they are corrections to existing, mostly-working flows.

---

## 7. Recommendations (strictly test-observed; no new features)

1. **[HIGH]** Correct relative import depth in `saved.html`'s scripts (`savedPage.js` → `../../../shared/`, `savedHelpers.js` → `../../shared/`); re-run to confirm `_svUid` sets and skeletons resolve.
2. **[MEDIUM]** Remove the hardcoded `'Saturday, 25 May 2026'` fallback in `book-step3.html`; compute a sane default or gate Step 3 behind slot selection.
3. **[MEDIUM]** Seed/verify artisans with GPS so the standard book-step2 → step3 → step4 path and dashboard Nearby Professionals are completable on real data.
4. **[MEDIUM]** Fix the malformed `viewBox` in `transaction-history.html`.
5. **[LOW]** Add a skeleton→empty/retry fallback for slow-network loads; consider a client 404 guard.
6. **[LOW / polish]** Replace stock Unsplash/Pinterest placeholder avatars in pro-card templates with real/uploaded artisan images before launch.

*Re-running [tests/e2e_customer_journey.py](e2e_customer_journey.py) after fixes will regenerate `e2e_results.json` and the screenshot set for regression comparison.*
