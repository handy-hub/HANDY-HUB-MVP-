# HandyHub — Architecture Reference

> Last updated: 2026-05-25  
> Status: MVP / Firebase phase. Migration-ready design.

---

## 1. System Layers

```
┌──────────────────────────────────────────────────────────┐
│                    FRONTEND (HTML/JS)                    │
│  customer-app/   artisan-app/   admin-dashboard/         │
│  No Firebase SDK calls. No Firestore queries.            │
│  Talks ONLY to: Services → Repositories → Providers     │
└──────────────┬───────────────────────────────────────────┘
               │ imports
┌──────────────▼───────────────────────────────────────────┐
│              shared/js/ — SHARED BUSINESS LAYER          │
│                                                          │
│  config/           appConfig.js  ← single source of      │
│                    truth for all keys, URLs, constants   │
│                                                          │
│  domain/services/  Business logic (auth, wallet rules)   │
│  data/repositories/ Data access (bookings, customers…)  │
│  services/         Cross-cutting (cache, notifications)  │
│                                                          │
│  app/              DI container + backend factory        │
│                    getAppContainer() → swappable backend │
└──────────────┬───────────────────────────────────────────┘
               │ implements
┌──────────────▼───────────────────────────────────────────┐
│         backend/providers/firebase/ (TEMPORARY)          │
│                                                          │
│  firebaseConfig.js           App init (singleton)        │
│  firebaseDatabaseService.js  Firestore CRUD + subs       │
│  firebaseAuthService.js      Firebase Auth               │
│  firebaseStorageService.js   Firebase Storage            │
│                                                          │
│  MIGRATION: swap this folder for:                        │
│    backend/providers/express/ → Express.js REST API      │
│    backend/providers/nestjs/  → NestJS microservices     │
│  No changes required in repositories or domain services. │
└──────────────┬───────────────────────────────────────────┘
               │ reads/writes
┌──────────────▼───────────────────────────────────────────┐
│          FIREBASE (temporary infrastructure)             │
│  Firestore · Auth · Storage · Cloud Functions            │
│                                                          │
│  Cloud Functions = the REAL backend.                     │
│  All financial operations live here, not in the browser. │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Configuration — Single Source of Truth

All environment values live in exactly **one** place per layer:

| Layer | File | Contains |
|---|---|---|
| Frontend (shared) | `shared/js/config/appConfig.js` | Firebase config, Paystack public key, platform constants (display-only), admin emails, MoMo providers |
| Cloud Functions | `functions/config.js` | DB ID, admin emails, commission rate, withdrawal limits, Paystack base URL |
| Secrets | Firebase Secret Manager | `PAYSTACK_SECRET_KEY` (set via `firebase functions:secrets:set`) |

**Never** hardcode API keys, DB IDs, admin emails, or business constants in any other file.

---

## 3. Financial Architecture — Browser Trust Boundary

```
            BROWSER (untrusted client)          │  CLOUD FUNCTIONS (trusted server)
                                                │
✅ Display wallet balances                       │  ✅ Credit walletBalance
✅ Open Paystack MoMo popup                     │  ✅ Debit walletBalance (withdrawals)
✅ Record PENDING topup transaction              │  ✅ Hold / release / refund escrow
✅ Call Cloud Functions via httpsCallable        │  ✅ Verify charge with Paystack API
                                                │  ✅ Initiate Paystack transfers
❌ Write walletBalance directly                 │  ✅ Process commissions
❌ Write escrowBalance directly                 │  ✅ Roll back on transfer failure
❌ Call Paystack secret-key endpoints           │  ✅ Write webhookLocks (idempotency)
❌ Compute final fees / commissions             │  ✅ Write financialAudit records
❌ Release or refund escrow directly            │
```

### Payment Top-Up Flow
```
Customer → Paystack popup → charge.success webhook
  → verifyCharge() confirms amount with Paystack API
    → Firestore transaction (webhookLock + wallet credit + audit)
      → Stale pending client record upgraded to 'successful'
```

### Withdrawal Flow
```
Customer → processWithdrawal Cloud Function
  → Firestore transaction: deduct balance + payout record
    → initiateTransfer() → Paystack API
      → transfer.success/failed webhook → balance confirmed or rolled back
```

### Escrow Flow
```
Booking confirmed → holdBookingFunds (caller = customer UID enforced)
  → Firestore transaction: walletBalance ↓, escrowBalance ↑
    → Job complete → releaseEscrow (caller must be party to booking)
      → Firestore transaction: escrow → artisan wallet - commission
        → Commission record, platform aggregate, audit log
```

---

## 4. Booking System — Dual-Layer Hybrid

The booking layer is a deliberate hybrid during the MVP HTML phase:

### Layer 1 — localStorage (UX speed layer)
```
window.HH_Booking  (shared/js/services/bookingService.js)
window.HH_State    (shared/js/services/stateService.js)
```
- Instant reads/writes — no network latency
- Drives all booking UI pages
- Survives page reloads within a browser session
- **Not authoritative** — does not survive device wipes or cross-device access

### Layer 2 — Firestore (authoritative persistence)
```
bookings/{bookingId}  collection
```
- Written by `bookingConfirmNotify.onBookingConfirmed()` after every confirmation (standard AND emergency)
- The booking ID is shared between both layers (`HHB-{timestamp}`)
- Artisan dashboard reads/writes Firestore only
- Admin dashboard reads Firestore only

### Bridge (the glue)
```
book-step4.html → HH_Booking.confirm() → onBookingConfirmed()  → Firestore
book-emergency.html → HH_Booking.confirmEmergency() → onBookingConfirmed({type:'emergency'}) → Firestore
```

### Known MVP Limitation
Artisan status changes (accept/reject) update Firestore but do **not** push to the customer's localStorage state. Customer sees stale status until they visit a Firestore-backed page.

**Post-MVP fix**: replace localStorage booking layer with a real-time Firestore subscription on `bookings/{id}`.

---

## 5. Firestore Security Model Summary

| Collection | Customer | Artisan | Admin |
|---|---|---|---|
| `customers/{uid}` | Read own / profile update | Read all | Full |
| `customers/{uid}/transactions` | Read own, create topup | — | Full |
| `artisans/{uid}` | Read all | Read own / profile update | Full |
| `artisans/{uid}/transactions` | — | Read own | Full |
| `bookings/{id}` | Read own, create, update status | Read own, update status | Full |
| `escrow/{id}` | Read own | Read own | Full |
| `webhookLocks/{ref}` | ❌ denied | ❌ denied | Read only |
| `financialAudit/{id}` | ❌ denied | ❌ denied | Read only |
| `admin_sessions/{uid}` | ❌ denied | ❌ denied | Own read/write |
| `verification_requests/{uid}` | ❌ denied | Own read/write | Full |

---

## 6. Firebase Provider Replacement Guide

To migrate away from Firebase, change only:

1. `shared/js/backend/providers/firebase/` → create `providers/express/` or `providers/nestjs/`
2. `shared/js/app/backendProviderFactory.js` → wire the new provider key
3. `functions/` → replace with Express.js / NestJS backend (financial logic stays the same)
4. `shared/js/config/appConfig.js` → update base URL, remove Firebase config

Everything else — repositories, domain services, UI pages — stays unchanged.

---

## 7. React Native Migration Readiness

### Already portable (no DOM, no window) ✅
- `shared/js/config/appConfig.js`
- `shared/js/domain/services/`
- `shared/js/data/repositories/`
- `shared/js/app/container.js` + `backendProviderFactory.js`
- `functions/` (stays as-is)

### Must be rewritten for React Native ❌
| Current | React Native replacement |
|---|---|
| `window.HH_Booking` / `window.HH_State` globals | Zustand / Redux booking store |
| HTML pages (book-step1 → book-step4) | React Native screens |
| CSS + DOM manipulation in pages | StyleSheet + RN components |
| `paystackService.js` (iframe popup) | Paystack React Native SDK |
| Firebase CDN `import from 'https://...'` | Firebase npm package |

### Migration sequence
1. Copy `shared/js/config/`, `shared/js/domain/`, `shared/js/data/` → RN project (plain JS)
2. Replace Firebase CDN provider with npm Firebase provider
3. Replace `bookingService.js` + `stateService.js` with Zustand store
4. Rewrite HTML pages as RN screens, importing the same repositories and services

---

## 8. Adding a New Collection — Checklist

- [ ] `firestore.rules` — add `match /newCollection/{id}` with role guards
- [ ] `shared/js/data/repositories/newRepository.js` — factory pattern
- [ ] `shared/js/app/container.js` — register the repository
- [ ] `functions/index.js` — add Cloud Function if server-side writes needed
- [ ] `shared/js/services/cachedDatabaseService.js` — add TTL if needed

---

## 9. Known Technical Debt (MVP)

### ✅ Resolved (audit 2026-05-25)
| Item | Resolution |
|---|---|
| Wallet double-credit exploit (CRIT-1) | `webhookLocks` idempotency check moved inside Firestore transaction |
| Escrow auth bypass (CRIT-2) | `assertEscrowAccess()` added to all escrow operations |
| Frontend balance mutation (CRIT-3) | `adjustWalletBalance()` and `recordWithdrawal()` removed |
| Non-crypto transaction refs (CRIT-4) | All `Math.random()` refs replaced with `crypto.getRandomValues()` / `crypto.randomBytes()` |
| Webhook trusted amount (CRIT-5) | `verifyCharge()` called before crediting wallet |
| Emergency booking not persisted (ARCH-1) | `onBookingConfirmed()` called from `book-emergency.html` |
| Config scattered across files | `shared/js/config/appConfig.js` and `functions/config.js` created |
| `notificationRepository.js` unbounded reads | `UNREAD_LIMIT=200`, `NOTIF_LIST_LIMIT=50` applied |
| `functions/notifications.js` hardcoded DB_ID | Now uses `FIRESTORE_DB_ID` from `functions/config.js` |
| `functions/notifications.js` Timestamp inconsistency | Now writes ISO string `createdAt` to match client |
| `notifications.js` missing `readAt` field | `readAt: null` added to all writes |
| `us-central1` hardcoded in wallet/paystack services | Now reads `FUNCTIONS_REGION` from `appConfig.js` |
| Case-sensitive path bug (`js/Pages/` vs `js/pages/`) | Fixed in all 8 customer-app HTML files and `Scripts/script.js` |
| Transfer rollback TOCTOU (VULN-1) | `FieldValue.increment()` replaces read-then-write in both withdrawal rollback paths |
| Webhook failure rollback TOCTOU (VULN-2) | `FieldValue.increment()` in `_updateTransferOutcome()` rollback section |
| Transfer.failed no idempotency (VULN-5) | Idempotency guard added in `_updateTransferOutcome()` — skips if payout already terminal |
| Escrow double-release (VULN-3) | `releaseEscrow()` re-reads and re-checks status inside the Firestore transaction |
| Escrow double-refund (VULN-4) | `refundEscrow()` re-reads and re-checks status inside the Firestore transaction |
| `freezeEscrowForDispute()` not transactional (VULN-12) | Final update wrapped in `runTransaction()` with re-check |
| Customer transaction type fabrication (VULN-7) | Firestore rule restricts client creates to `type == 'topup'` only |
| Booking create blocks null artisanId (VULN-8) | Rule allows `artisanId == null` when `bookingType == 'emergency'` |
| Booking ID minute-level collision (VULN-10) | `generateBookingId()` appends 4 crypto-random hex chars (65 536 combinations/min) |
| Artisan update no `hasOnly()` check (VULN-13) | `isSafeArtisanProfileUpdate()` added — blocks financial field writes by owner |
| Notification spam / spoofing (VULN-17) | `customer_notifications` create rule requires `senderId == request.auth.uid` |
| Dispute booking ownership not verified (VULN-18) | Dispute create rule does `get()` on booking and verifies caller is a party |

### 🔴 Outstanding
| Item | Priority | Fix |
|---|---|---|
| Artisan status not synced to customer localStorage | High | Real-time Firestore sub on booking doc |
| `bookingService.js` uses window globals | High | Blocks RN migration — rewrite as store |
| `artisanRepository.applyNewReview()` TOCTOU race | Medium | Move to Cloud Function with Firestore transaction |
| `artisanRepository.incrementJobsCompleted()` TOCTOU | Medium | Move to Cloud Function with `FieldValue.increment()` |
| No Firebase App Check / rate limiting | Medium | Add App Check in production |
| No offline state management | Medium | Firestore `enablePersistence()` + offline UI |
| No server-side minimum topup enforcement | Medium | Add min-amount check in webhook before crediting |
| Emergency artisanId is often null | Medium | Matching/dispatch system needed |
| `_clearDefaults()` does N separate Firestore writes | Low | Replace with `writeBatch()` via service layer |
| `PROVIDER_META` SVG logos inline in JS | Low | Move to `/assets/` or CSS |
| `matching.js` and `bookings.js` are placeholders | Post-MVP | Real matching and booking Cloud Functions |
