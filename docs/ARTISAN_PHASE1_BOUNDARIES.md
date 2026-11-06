# Artisan app — Phase 1 migration boundaries

Prepared 2026-11-06 at the end of Phase 0, on branch `fix/phase0-remediation`
(base `99a0d8d`). **Phase 1 has not started.** It starts only on the product
owner's explicit approval, and the decisions in §5 shape specific screens.

Read with: `CLAUDE.md` (instant UX, money, role isolation), the Phase 0 discovery
report and the Workbench prototype (links in the Phase 0 finalization report).

---

## 1. What Phase 1 is, and is not

Phase 1 rebuilds the **presentation layer** of `artisan-app/`: tokens and
components first, then the Today / Offer / Active Job screens from the Workbench
prototype, then the navigation model.

It is **not** a change to booking rules, money, dispatch, pricing or privacy
policy. Each of those is a separate, approved change with its own tests (§6).

| Phase 1 may change | Phase 1 must not change without separate approval |
|---|---|
| `artisan-app/*.html` markup, page CSS and page scripts | `firestore.rules`, `storage.rules` |
| `artisan-app/css/design-system.css` (through the token process) | anything under `functions/` |
| new shared UI components under `shared/js/ui/` | what an existing `shared/js/domain/*` function **answers** (the customer app reads the same modules) |
| copy that describes state, where §3's functions supply the facts | brand, banner or marketing copy (ask first, list every visible change) |
| | which money figure is shown (gross/net) — decision 07 / BE-01 |

Adding a new domain function is fine. Changing an existing answer means updating
its guard tests in the same change and stating the effect on the customer app.

---

## 2. The architecture constraint that does not move

HandyHub/Fidus X is a **multi-page application**: navigation is a full document
load. Screens paint from `mountInstantView()` (`shared/js/services/instantView.js`)
before the network answers. A rebuilt screen that waits on the network where the
old one painted from cache is a regression (`npm run lint:instant`). Money
figures may be shown from cache; no financial decision is taken from it.

---

## 3. Contracts a rebuilt screen consumes — never re-implements

Phase 0 found every workflow defect in screens that answered these questions with
their own copy of a list. A rebuilt screen asks the shared function.

| Question | Function | Module | Guard |
|---|---|---|---|
| May this artisan cancel now? | `artisanCanCancel(b)` | `shared/js/domain/bookingActions.js` | `test:artisan-actions` (vs the real `cancelInspectionBooking`), `test:workflow-rules` |
| Perform a transition | `performBookingAction()` | same | `test:booking-actions` — routes inspection cancels to the Cloud Function |
| Must the artisan quote before travelling? | `needsQuoteBeforeTravel(b)` | `bookingStatusMeta.js` | `test:artisan-actions`, `test:workflow-rules` |
| Is this a paid emergency priced on site, and is the quote the step now? | `quotesOnSite(b)`, `needsQuoteOnSite(b)` (`emergencyPricedOnSite(b)` in `bookingTruth.js`) | `bookingStatusMeta.js` | `test:artisan-actions` (holds the two copies equal), `test:emergency-onsite` |
| Was the customer's location removed (14 days after close)? | `resolveJobBrief(b).location.precision === 'removed'` | `bookingTruth.js` | `test:location-retention` |
| Which actions apply? | `getAllowedActions(b, 'artisan')` | same | `test:artisan-actions` (property test over every status) |
| Where are we, what next, which button? | `resolveJourney(b, 'artisan')` | `bookingTruth.js` | `test:booking-truth`, `test:artisan-actions` |
| Rating, or "No reviews yet" | `resolveRating(a)` | `bookingTruth.js` | `test:artisan-push-rating` |
| Trade names | `serviceLabel()` | `bookingTruth.js` | `test:artisan-polish` |
| Appointment, may work start? | `resolveSchedule()`, `canStartWork()` | `bookingSchedule.js` | `test:booking-schedule`; rules `scheduleWindowOpen()` (90 min) |
| Offer state, countdown, lapse | `offerState()`, `createOfferWatcher()`, `lapseOfferButtons()` | `jobOffers.js` | `test:offer-expiry`, `test:offer-refusal`, `tests/e2e/offer_refusal.py` |
| Push on this device | `getPushState()`, `describePushState()` | `pushState.js` / `pushNotificationService.js` | `test:push`, `test:artisan-push-rating` |
| Quote entry | `mountQuoteComposer()` | `shared/js/ui/quoteComposer.js` | `test:artisan-jobs-page`, `test:marketplace`, `test:artisan-keyboard`, `tests/e2e/quote_context.py` |
| "Are you sure?" | `confirmSheet()` | `shared/js/ui/confirmSheet.js` | `test:confirm-sheet` |
| Instant first paint | `mountInstantView()` | `shared/js/services/instantView.js` | `lint:instant`, `test:artisan-cache-first` |
| Who is signed in, may they act? | `requireArtisanAuth()`, `subscribeToArtisanAuthState()`, `canAcceptJobs()` | `artisan-app/js/utils/artisanAuthGuard.js` | `test:artisan-login`, `test:login-outage` |

Two quote UIs exist today: `jobs.html` keeps its own sheet beside the shared
composer used by `job.html`. Phase 1 should retire the `jobs.html` sheet in favour
of `mountQuoteComposer()`, carrying over `tests/artisan-keyboard-a11y.test.cjs`'s
guarantees (inert when closed, Escape, focus return).

---

## 4. Tests that pin today's page source

34 test files read artisan page source directly (regex pins on markup and
inline scripts). A rebuilt page **will** break many of them. That is expected.
Deleting them is not.

The rule: when a rebuilt page breaks a pin, the same change re-expresses the same
behaviour against the new page — ideally by running the page's own code, as the
newer tests do — and the commit lists each pin and its replacement. A pin is
never deleted or loosened without a replacement that proves the same thing.

| Page | Test files that read it |
|---|---|
| dashboard | artisan-actions-consistency, artisan-availability, artisan-dashboard-page, artisan-medium-ui, artisan-push-rating, confirm-sheet, flow-004-outage, import-paths, inspection-completion, notification-safety, offer-expiry, offer-refusal, privacy-access, push-delivery, wallet-settings-platform |
| jobs | artisan-availability, artisan-dashboard-page, artisan-jobs-page, artisan-keyboard-a11y, booking-truth, confirm-sheet, flow-004-outage, inspection-completion, marketplace-integrity, notification-safety, offer-expiry, offer-refusal, privacy-access, push-delivery |
| job | artisan-actions-consistency, artisan-medium-ui, booking-truth, confirm-sheet, offer-expiry, offer-refusal, privacy-access |
| settings | artisan-contact, artisan-push-rating, wallet-settings-platform |
| profile | artisan-polish, artisan-push-rating, marketplace-integrity, profile-photo-lifecycle, wallet-settings-platform |
| wallet | artisan-wallet-nav, artisan-wallet-page, config-consistency, notification-safety, payout-integrity, push-delivery, wallet-settings-platform |
| messages, notifications, reviews, performance, support | artisan-cache-first, artisan-messages-page, artisan-medium-ui, artisan-polish, artisan-wallet-nav, notification-safety, support-thread, config-consistency, artisan-actions-consistency, privacy-access |
| login, signup, onboarding | artisan-login, artisan-signup-page, login-outage, legal-pages, artisan-medium-ui, artisan-contact, artisan-privacy-rules, profile-photo-lifecycle, privacy-access, config-consistency, marketplace-integrity, booking-truth |

Browser checks that must stay green across Phase 1 (local emulators, see
`tests/e2e/`): `artisan_availability.py` (40), `messaging_realtime.py` (12),
`messaging_context.py` (8), `quote_context.py` (12), `offer_refusal.py` (26),
`artisan_cache_first.py` (43), `support_thread.py` (17),
`messages_thread_stacking.py` (4).

---

## 5. Decisions that shape Phase 1 screens

Q1–Q6 were decided on 2026-11-06 and are implemented on this branch (local,
not deployed). The screens a rebuild produces must follow them; the guard tests
named here hold them.

| Decision | Behaviour | Screen it shapes | Guard |
|---|---|---|---|
| Q1 Emergency: a paid emergency sets out at once and is priced on site; "done" waits for the approved quote | `quotesOnSite`, `needsQuoteOnSite` (bookingStatusMeta), `emergencyPricedOnSite` (bookingTruth), rules, `quotes.js` | Active Job (emergency), Today dock | `test:emergency-onsite`, `test:artisan-actions`, `test:workflow-rules` |
| Q2 Escrow timer: work en route or in progress is never refunded by the timer; held, support alerted, re-checked daily | `escrowAutoRelease.js` | Active Job payment block | `test:escrow-work-hold` |
| Q3 Offers while on a job: keep sending, full window | unchanged dispatch | Today (offer over an active job) | `test:dispatch-liveness` |
| Q4 Cancel a future booking: no cut-off | server allows until approval; job screen offers it | Active Job ⋯ menu | `test:artisan-actions` |
| Q5 Leaving after approval: support decides | "Get help with this job" → Support with the booking | Active Job ⋯ menu | `test:artisan-actions` |
| Q6 Address retention: 14 days after the job closes | `locationRetention.js`; job record says it was removed | Job history, Active Job | `test:location-retention`, rules suite |
| PS-01 remainder: chat bound to bookings, contact window | **Undecided.** Enquiries before booking and chats after the job are still allowed | Messages inside the job (decision 10) | — |
| 01 accent, 02 tabs, 03 reputation, 04 dark mode, 05 wordmark, 07 net figure, 08 neighbourhood, 09 map | **Undecided.** Workbench proposals | Tokens, navigation, Offer, Active Job | — |
| Emergency base GHS 80 | **Undecided.** In `PRICING_PRODUCTION`, marked "awaiting business approval" | Offer and quote figures | — |

Messaging inside the job (decision 10) is blocked until the PS-01 remainder is
decided: the thread is per customer–artisan pair, not per booking.

---

## 6. Prepared changes awaiting approval

Specified, not applied. Each lands as its own reviewed change with tests. (Q1,
Q2 and Q6 were specified here and are now implemented; Q3, Q4 and Q5 were
decided as today's behaviour.)

**Privacy policy wording (Q6).** `shared/legal/privacy.html` §3 says the job
address is shared "while the booking is active". With Q6 the true statement is
that the artisan sees the job address from acceptance until 14 days after the
job ends. Legal text, so it changes only with approval. Proposed: "When a
booking goes ahead, we share with the artisan what the job needs: your name and
the job address, from acceptance until 14 days after the job ends, and your
phone number while the booking is active (from acceptance until the job is
done)."

**Q6 backfill run.** `adminMigrateContactPrivacy` now also stamps bookings closed
before retention existed (and removes the address from old reminders). Run it
dry-run first, after the release, with approval; never automatically.

**PS-01 remainder.** Require a booking link for artisan-initiated threads and/or
close threads N days after the job ends. Rules + the chat section of
`tests/firestore-rules.test.mjs`.

**BE-01 — net figure on offers.** Add a server-computed `artisanNet` to
`OFFER_FIELDS` (`functions/jobOffers.js` ≈ line 53) from `planHold`'s commission;
the Offer shows it. Display policy first (15% applies to the callout too).

**Production read of `pricing_config`.** Read-only check that no override
contradicts `PRICING_PRODUCTION`. Needs authorization (production access).

---

## 7. External dependencies

| Need | Blocks |
|---|---|
| Fidus X logo (SVG) and a square app icon | VI-01 (signup still shows the Handy Hub mark), installable PWA (IN-01) |
| Fidus X push icon | `shared/push/firebase-messaging-sw.js` still uses `handyhub-logo.png` |
| Installable PWA | iOS web push for artisans |
| Paystack merchant status (inactive as last recorded, 28 Oct; not re-checked) | real payments, payouts |
| Maps key restrictions | decision 09 (map on the active job) |
| A reverse-geocoding source inside existing functions | decision 08 (neighbourhood); never invent labels |

---

## 8. Debt carried into Phase 1

- Every page constructs every repository (`shared/js/app/container.js`, BE-04).
- Font Awesome loads from cdnjs on `jobs.html` and `reviews.html`; the dashboard
  avatar falls back to `ui-avatars.com`, which receives the artisan's initial.
- The dashboard's performance deltas ("+0%", "+0.0") are static placeholders.
- Tap targets under 44 px: dashboard 9, jobs 24 (measured at 360 px).
- Orange focus borders (#F97316 on white, ≈2.8:1) on the composer and support
  fields sit below the 3:1 non-text minimum; tied to accent decision 01.
- `artisanAuthGuard.js` asks for notification permission on page load, without a
  user gesture; when to ask belongs to the onboarding design.
- `bookings.html` only redirects (to `job.html?id=` when given an id, else `jobs.html`).
