# Artisan Development Access Mode

A **temporary, non-production** development aid that lets the Artisan App shell be
built and navigated without completing real Firebase login + onboarding — **without
deleting, weakening, or bypassing** the real authentication, onboarding, role, or
approval systems. The moment the flag is off (or the app runs on a production host),
the real system runs verbatim.

## Why it exists
The Artisan App's pages are all gated by `requireArtisanAuth`, which requires a real
Firebase user + an approved `artisans/{uid}` Firestore document. While the rest of the
app is still being built, that gate blocks every screen. Dev Access Mode holds auth +
onboarding at the development boundary so screens can be completed, then flips back off
to restore the full flow — no rebuild required.

## The one switch
`shared/js/config/devAccess.js`:
```js
export const ARTISAN_DEV_ACCESS = true;   // ← the ONLY flag
```
There is exactly one flag and one fail-safe. No page has its own bypass.

## How to enable / disable
- **Enable:** `ARTISAN_DEV_ACCESS = true` **and** run on a local host (localhost,
  127.0.0.1, a `192.168.*`/`10.*` LAN address, or `file://`).
- **Disable:** set `ARTISAN_DEV_ACCESS = false`. That's it — real auth returns everywhere.

## Which environments permit it (fail-safe)
`isArtisanDevAccessEnabled()` returns true only when the flag is on **and**
`isProductionEnvironment()` is false. It **fails closed**: production hosts
(`lamax-artisan.web.app`, `lamax-4fd82.web.app`, `lamax-4fd82.firebaseapp.com`),
anything that isn't clearly local, and any error all resolve to "production" → bypass
**off**. A stray `true` cannot ship a backdoor to real users.

## How the mock session works
- `shared/dev/artisanDevSession.js` is the **one** canonical mock artisan (uid
  `dev-artisan-0001`, `@dev.handyhub` emails — deliberately non-production).
- `requireArtisanAuth` resolves this mock `{ user, artisan }` instead of Firebase +
  Firestore when dev mode is active. Every artisan page therefore sees the **same**
  artisan — no page hardcodes its own fake values.
- It never touches Firebase Auth, Firestore, or push notifications.

## Switching development states
A dev-only badge (bottom-left, "DEV MODE") opens a state switcher. Selecting a state
persists it to `localStorage` and reloads, so the guard re-resolves cleanly. States:

| State | Gate reproduced |
|---|---|
| New Artisan | enters (draft/pending) |
| Onboarding Incomplete | enters (draft) |
| Pending Approval | KYC-pending overlay on approval-required pages |
| Approved — No Jobs | enters (empty states) |
| **Approved — Active Jobs** (default) | enters (rich data) |
| Approved — Completed + Earnings | enters |
| Suspended / Restricted | suspended overlay |
| Data / Offline Error | error/unauthorized overlay |

The switcher sits **above** the auth overlay, so you can always switch out of a blocking
state. It only exists in dev mode.

## What is simulated vs blocked
- **Simulated:** the artisan identity + record (name, category, rating, wallet summary,
  verification/approval status, availability, stats) that pages read from the session.
- **Not written anywhere:** the mock is never persisted to Firestore.
- **Still real (next layer):** per-screen list data (jobs, bookings, notifications,
  reviews) is fetched by each page from its repositories, not from the session. Those
  render from whatever the repos return. To fully populate every screen offline, use the
  **Firebase Emulator Suite** or add per-repo dev adapters keyed on
  `isArtisanDevAccessEnabled()` — do **not** write demo data into production Firestore.
- **Must stay blocked:** payments, withdrawals, payouts, escrow, verification-document
  uploads, and Cloudinary deletes must not fire real operations under a mock session.
  When wiring those screens, gate the action behind `isArtisanDevAccessEnabled()` and
  return a controlled dev response with the same frontend contract.

## Logout in dev mode
`_agSignOut` (the one logout path) detects dev mode, clears the mock state, and returns
to `login.html` — it never tries to sign out a Firebase user that doesn't exist. In
normal mode it uses the real Firebase sign-out unchanged.

## Restoring the full auth + onboarding flow later
Set `ARTISAN_DEV_ACCESS = false`. Optionally delete `shared/dev/` and the dev imports in
`artisanAuthGuard.js`. No page needs changing — they already resolve through the one guard.

---

## Production safety checklist
Before any production build / deploy, confirm:

- [ ] `ARTISAN_DEV_ACCESS = false` in `shared/js/config/devAccess.js`.
- [ ] Verified on the deployed host: no "DEV MODE" badge appears.
- [ ] `isArtisanDevAccessEnabled()` returns `false` on the production host (fail-safe also
      enforces this even if the flag was left `true`).
- [ ] No mock artisan data renders; pages require real login + onboarding.
- [ ] Unauthenticated users are redirected to login; incomplete artisans reach onboarding;
      pending artisans see the approval screen; approved artisans reach the app.
- [ ] Payment / wallet / withdrawal / verification-upload stubs (if added) are inactive.
- [ ] No demo customers, bookings, payments, or artisan records exist in production Firestore.
