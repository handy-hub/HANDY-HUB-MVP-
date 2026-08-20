# HandyHub — engineering contract

Read this before changing anything. It records the constraints that are load-bearing:
breaking one is a regression even when the code compiles, the tests pass, and the
screen looks right.

---

## 1. HandyHub must feel instant

**RENDER FIRST. FETCH SECOND. NEVER BLOCK THE USER UNNECESSARILY.**

When a customer opens a screen they have seen before, it must appear **immediately**
from cache. Fresh data arrives silently afterwards. A full-screen spinner is only
acceptable when there is genuinely nothing to show.

This is a permanent architectural law, not a per-page optimisation. Any change that
makes a previously instant screen wait on the network is a **performance regression**
and must be redesigned, regardless of how much cleaner the new code looks.

### The architecture you must use

`shared/js/services/instantView.js` — **`mountInstantView()`**.

```js
import { mountInstantView } from '../../shared/js/services/instantView.js';

const view = mountInstantView({
  key:       'saved-artisans',
  version:   1,
  render:    (items) => renderList(items),
  onEmpty:   () => showSkeleton(),          // ONLY on a genuine cache miss
  subscribe: (uid, onData, onErr) => repo.subscribeToSaved(uid, onData, onErr),
});
window.addEventListener('pagehide', () => view.destroy());
```

It handles uid scoping, first paint, background revalidation, account switching and
teardown. **Do not hand-roll caching in a page module.** Two production bugs came from
exactly that, and both were invisible in review:

- The promo banner used a 10-minute TTL, so any visit more than ten minutes later fell
  to the cold path and shimmered. TTL had been conflated with the freshness window.
- The notification list read its cache under a bare key and wrote it under a
  uid-scoped one, because the uid is only known after auth resolves. The keys never
  matched, so the cache was never once read.

### Why this shape, and not React conventions

**HandyHub is a multi-page application.** Navigation is `location.href` — a full
browser document load that destroys the JS heap, every listener and all in-memory
state. There is no React, no React Native, no TanStack Query, no navigation stack.

So advice about keeping screens mounted, avoiding remounts, or configuring a query
client **does not apply here** and cannot be implemented without an SPA rewrite. The
achievable equivalent — and the thing that actually works — is painting from a
navigation-surviving cache before the network is consulted.

If you are asked to "preserve screen state across navigation", say plainly that this
requires an SPA conversion, and implement cache-first painting instead.

### Freshness tiers — do not apply one rule to everything

| Data | Policy |
|---|---|
| Profiles, categories, service copy, images | Cache aggressively; long TTL |
| Notifications, bookings, saved lists, search | Cache + background revalidate |
| Availability, ETA, live job state | Realtime listener; cache last known state |
| **Wallet, escrow, payment, withdrawal state** | **Backend authoritative — never decide from cache** |

Cached money figures may be *displayed* for continuity. No financial decision may be
taken from them. Use `stripFields` to keep money out of the cache entirely.

### The test every new screen must pass

A customer has visited this screen once and returns to it.

1. Does it appear immediately from cache?
2. Is their context preserved (scroll, filters, tab, query)?
3. Does it refresh silently, without blanking?
4. If the network is slow, does it stay useful?
5. If the refresh fails, does existing content survive?
6. Is the backend still authoritative for anything transactional?

Any "no" means it is not finished.

CI guard: `npm run lint:instant` (`scripts/check-instant-ux.cjs`).

---

## 2. Money is backend-authoritative, always

- Wallet credits run through **one** idempotent settlement path
  (`settleTopupByReference` in `functions/financial/webhooks.js`). The webhook and the
  client-triggered `verifyTopupNow` both converge there. **Never add a second one.**
- Idempotency is a transactional lock keyed on the Paystack reference. The wallet
  credit and the payment-record transition happen in the **same Firestore
  transaction** — money cannot move without the record moving with it.
- The client may never assert that a payment succeeded. It supplies a reference; the
  server asks Paystack.
- Firestore rules forbid client writes to `walletBalance`, `escrowBalance` and
  `spent`. Proven by `npm run test:rules` (16 tests). Keep them passing.
- Never show "Payment successful" before backend confirmation. A pending state is
  honest; a premature success is not.

## 3. Role isolation

A UID is a customer **or** an artisan, never both. Enforced in four layers
(client guard, auth service, Cloud Functions, Firestore rules). See
`docs/SECURITY_ROLE_ISOLATION.md`. Read it before touching auth, signup or routing.

## 4. Cloud Functions

- Region is **`europe-west1`** — frontend and backend must agree.
- Firestore is a **named database** (`ai-studio-5589039d-…`), not `(default)`. Every
  Firestore trigger **must** pass `database: FIRESTORE_DB_ID` or it deploys dead and
  silently never fires.
- `setGlobalOptions({ maxInstances: 1 })` is deliberate. The binding limit is the
  Cloud Run **Instances** quota (100/region), *not* CPU — Cloud Run misreports it as
  a CPU error. Raise the quota before raising the cap.
- Deploys frequently fail to set invoker IAM on this project. After deploying a new
  callable, verify it returns 400/401 rather than **403**, and grant
  `allUsers`/`run.invoker` if not.
- Deploys need `FUNCTIONS_DISCOVERY_TIMEOUT=90`; the default 10s is not enough and
  fails with a misleading "user code failed to load".

## 5. Verify against reality, not exit codes

This project has repeatedly produced green commands over broken systems:
a functions deploy exited 0 while 43 of 47 failed; functions showed "deployed" while
returning 403 to every caller; a KYC upload reported success while storing nothing.

Before claiming something works: probe the endpoint, read the logs, query the data.
"The command succeeded" is not evidence.

## 6. Commands

```bash
npm run lint            # syntax, filters, tokens, status vocab, instant-UX
npm run lint:instant    # the instant-UX guard specifically
npm run test            # full suite
npm run test:rules      # Firestore rules against the emulator
npm run test:topup-charge   # 52 money-invariant tests
npm run deploy:ca       # stage + deploy customer app
```

Full system map: `ARCHITECTURE.md`. Performance history:
`docs/CUSTOMER_APP_PERFORMANCE_AUDIT.md`.
