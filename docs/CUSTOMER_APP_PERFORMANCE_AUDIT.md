# Customer App — Navigation & Data-Lifecycle Performance Audit

**Scope:** Root-cause audit of "the dashboard reloads / the banner flashes when I
navigate away and come back," plus the caching/navigation architecture around it.
**Method:** Source trace of the boot sequence, caching services, auth guard, and the
banner; unit-tested the new cache; **live Firebase read counts are code-path-derived
estimates, not a browser-instrumented measurement** (see §12 — a live pass is the
recommended verification and is not yet done).
**Outcome of this pass:** the banner flash is fixed at the root; a canonical
navigation-surviving cache was introduced; the larger architectural items are
scoped as a **gated roadmap** (§16), not executed blind.

---

## 1. Executive summary — the reframing

The premise "the app rebuilds from zero every time you change screens" is only
**partly** true, and that distinction is the whole audit.

- **It is a multi-page app (MPA).** Every screen is a separate HTML document;
  navigation is `window.location.href` / `<a href>`. So *every* return to the
  dashboard is a genuine cold document load — the DOM and all JS state are torn
  down and rebuilt. That is structural (fixing it fully means an app-shell/SPA —
  §16, gated).
- **But most dashboard sections already defend against that** by instant-painting
  from persistent storage, so they do *not* blank-and-refetch:
  - profile name/avatar/location → `localStorage` paint ([dashboard.html:712-757](../customer-app/dashboard.html))
  - saved location → `localStorage` paint ([dashboard.html:287](../customer-app/dashboard.html))
  - nearby professionals → `localStorage` TTL pool, *"renders from cache at ZERO Firestore reads"* ([nearbyPros.js:38-39,166-170](../customer-app/js/nearbyPros.js))
  - popular services / chips → the in-page `serviceCatalog` (static, no read)
- **The banner was the one section that never adopted this.** It shimmered, read
  the `promotions` collection, and rebuilt from scratch **on every single visit**
  ([adBanner.js `mountAdBanner`](../customer-app/js/adBanner.js), old lines 305-313).
  Because the banner sits above the fold and animates, its flash made the *entire*
  return read as "a full reload," masking the fact that the rest was already stable.

**So the highest-leverage, lowest-risk fix is not a rewrite — it is bringing the
banner onto the exact persistent-SWR pattern the rest of the app already uses.**
That is what this pass did.

---

## 2. Navigation lifecycle (traced)

| Moment | What actually happens |
|---|---|
| **First open / deep link** | Document loads → `authInit.js` `requireAuth()` gates (auth + role read) → notification badge subscription opens → booking history seeded from Firestore → section scripts (`nearbyPros`, `resumeCard`, popular services, banner) run on/after `DOMContentLoaded`. |
| **Browser refresh (F5)** | Full document reload — identical to first open. `localStorage` caches survive, so profile/location/nearby instant-paint; banner (pre-fix) re-shimmered. |
| **Dashboard → another page** | `window.location.href` → full unload. In-memory state (incl. the `cachedDatabaseService` memory cache) is destroyed. Only `localStorage`/`sessionStorage` survive. |
| **Back button (hardware/browser)** | Eligible for the browser **bfcache** (instant restore, zero JS re-run) *unless* something disqualifies the page — see §7. The app's own in-page back buttons use `window.location.href` (a forward nav), so they do **not** use bfcache. |
| **Return to dashboard** | A fresh cold document load (see "First open"), re-running the full boot. Instant-paint sections reappear immediately; the banner (pre-fix) re-fetched + rebuilt. |

**Navigation contract:** back/entry-path behaviour is handled per-page
(`authGuard` saves `hh_auth_redirect`; `fastLoader` shows the top progress bar on
`<a href>`). Nothing in this pass changes navigation targets, history handling, or
deep-link behaviour.

---

## 3. Root causes

| # | Root cause | Evidence | Severity |
|---|---|---|---|
| **RC1** | **MPA cold document load on every navigation** — the structural driver. Nothing in-memory survives a screen change. | separate `.html` docs; `window.location.href` everywhere ([adBanner.js:206-238](../customer-app/js/adBanner.js), back buttons) | Structural (gated fix) |
| **RC2** | **Banner had no navigation-surviving cache** → shimmer + `promotions` read + full DOM rebuild every visit = the flash. | `mountAdBanner` old preamble: `classList.add('ads-loading'); banners = await loadBanners(user)` unconditionally | **High — the reported symptom** |
| **RC3** | **The generic cache is memory-only** → provides *zero* cross-navigation benefit; each page re-reads Firestore. | `memoryCacheService` header: *"Lives only for the current page lifetime — no persistence"* ([memoryCacheService.js:1-13](../shared/js/services/memoryCacheService.js)); wired as the only wrapper in [container.js:19](../shared/js/app/container.js) | Medium |
| **RC4** | **Redundant auth resolution** — no shared session singleton for the resolved user; `requireAuth()` is called independently by `authInit.js` **and** the banner block, each re-running `waitForUser()` + `resolveAppRole()`. | [authInit.js:6](../customer-app/js/authInit.js), [dashboard.html:496](../customer-app/dashboard.html); `requireAuth` builds a fresh Promise + role read each call ([authGuard.js:153-227](../shared/js/utils/authGuard.js)) | Medium |
| **RC5** | **No cache versioning / SWR discipline as a shared primitive** — the good instant-paint patterns are bespoke per section (profile, location, nearby each hand-roll their own key + TTL), so a new section (the banner) simply missed the pattern. | 3 separate ad-hoc localStorage cache implementations | Medium (maintainability) |

**Not a cause (checked, ruled out):** there is **no** `location.reload()` loop, no
cache-busting query param on internal nav, and no "hide banner when active booking"
rule (the prompt's conditional) — `resumeCard.js`'s `hidden` toggling is the
in-flight *inspection-recovery* card, unrelated to the banner. Financial data is
**already** correctly excluded from caching (`cachedDatabaseService` documents that
wallet/escrow must use subscriptions, and does).

---

## 4. Duplicated / redundant fetch inventory

| Fetch | Where | Status |
|---|---|---|
| `promotions` collection read | banner, **every** dashboard load | **FIXED** — now served from a persistent SWR cache; a read happens only when the cache is stale (>60s) or absent. |
| `requireAuth()` (⇒ `waitForUser` + `resolveAppRole` role read) | `authInit.js` **and** banner block | **Partly fixed** — the banner no longer forces its own `requireAuth`+customer read on a warm load (now lazy, §10). The `authInit` gate is unchanged. Full de-dup onto a session singleton is **RC4 / Tier-2 (gated)**. |
| `customerRepository.getById(uid)` | banner block, every load | **Partly fixed** — only runs now when the banner actually needs to fetch fresh promos (lazy provider). |
| Same-collection reads within one page | any two callers | Already deduped — the DI container is a **singleton** ([container.js:67-76](../shared/js/app/container.js)) so its memory cache is shared within a page. (No *in-flight* promise dedup, though — two truly-concurrent identical reads still double-fetch; Tier-2.) |

---

## 5. Listener inventory & ownership

| Listener | Owner | Cleanup | Verdict |
|---|---|---|---|
| Notification badge `onSnapshot` | `authInit.js` via `HH_initNotifications` | `pagehide` → unsub ([authInit.js:88-91](../customer-app/js/authInit.js)) | ✅ owned + torn down |
| `onAuthStateChanged` inside `waitForUser()` | per `requireAuth()` call | resolves once then `stop()`s | ✅ not a permanent leak (but called redundantly — RC4) |
| Banner `visibilitychange` / `resize` / timer | `mountAdBanner` | — | ✅ **single mount per page** guaranteed by design (§10) — the render/wire path runs exactly once (cache **or** fresh, never both), so these are never duplicated. |
| Quote-approval modal | `authInit.js` `initQuoteModal` | `pagehide` → `destroyQuoteModal` | ✅ owned + torn down |

No duplicate `onSnapshot` on the same collection was found. The listener risk was
*potential* double-wiring of the banner on a re-render — the fix explicitly avoids
re-rendering within a view (§10), so it cannot occur.

---

## 6. What already works (do not "fix")

Profile, avatar, location, nearby-pros, and popular-services **already** instant-paint
and already avoid refetch-on-return. Preserving these untouched was a goal; this pass
did not modify them.

---

## 7. bfcache note

The browser back/forward cache would restore the whole page instantly (zero reads) on
a hardware back. Nothing obviously disqualifying was introduced, but the app uses
`pagehide` (bfcache-friendly) rather than `unload` (good). A dedicated bfcache
verification (DevTools → Application → Back/forward cache) is listed in §16.

---

## 8. Caching strategy introduced

One canonical, versioned, navigation-surviving cache — [`shared/js/services/persistentCache.js`](../shared/js/services/persistentCache.js):

```
readCache(key, { uid, version, ttlMs, storage })  → { data, ageMs } | null
writeCache(key, data, { uid, version, storage })  → boolean
invalidateCache(key, { uid, storage })            → void
```

- **Versioned:** an entry with a different `version` is discarded — future schema
  changes can't surface corrupt/incompatible data (a `version` bump invalidates all).
- **TTL'd + age-aware:** returns `ageMs` so callers implement stale-while-revalidate
  (paint now; revalidate only if old enough).
- **uid-scoped:** per-user data can't leak across accounts on a shared device
  (key suffix **and** an in-envelope uid check).
- **Fail-safe:** private-mode / quota / corrupt JSON all degrade to a clean miss,
  never a throw.
- **Guard-railed:** documented as **presentation-data only** — never wallet /
  payment / escrow / live status (those keep real-time subscriptions).

It is the shared home for the pattern `nearbyPros.js` / the profile paint already
hand-roll; those can migrate onto it later (Tier-2), and new sections must use it.

---

## 9. Cache policy per data source

| Data | Store | TTL / stale | Revalidate | Invalidated by | Survives nav | Survives refresh | Mechanism |
|---|---|---|---|---|---|---|---|
| **Promotions (banner)** | `localStorage` (`hh_pc_promotions_<uid>`) | 10 min usable / 60 s "fresh" | background, next-load, only when >60s old | TTL, `version` bump | ✅ | ✅ | **persistentCache SWR (NEW)** |
| User profile (name/avatar/loc) | `localStorage` `hh_profile_cache_<uid>` | 24 h | live subscription updates it | logout purge | ✅ | ✅ | existing bespoke |
| Saved location | `localStorage` `hh_detected_location_<uid>` | app-defined | on new GPS detect | user action | ✅ | ✅ | existing (HH_State) |
| Nearby artisan pool | `localStorage` TTL | TTL | on expiry / explicit retry | TTL | ✅ | ✅ | existing bespoke |
| Service catalog / chips | in-page module | n/a (static) | n/a | code change | n/a | n/a | `serviceCatalog.js` |
| Booking history | `localStorage` `hh_booking_history_<uid>` | seeded each login | login seed + writes | logout purge | ✅ | ✅ | existing (HH_State) |
| **Wallet / escrow / payment / live status** | **none — real-time only** | **n/a** | **onSnapshot** | **server** | ❌ (never cached) | ❌ | **subscription (unchanged, correct)** |
| Active booking / quote state | subscription + `HH_State.booking` snapshot | short | onSnapshot | status change | snapshot only | snapshot only | unchanged |

The strict rule from `cachedDatabaseService` — *financial data is never served from a
one-shot cache* — is preserved; the new cache explicitly forbids it too.

---

## 10. The banner fix (detail)

Stale-while-revalidate with a **single mount** invariant:

1. **Resolve uid** the same way the profile paint does (`HH_State.currentUid()` →
   `hh_last_session_uid`).
2. **Read the cache.** If a valid, non-empty payload exists → **`renderAndWire()`
   immediately, no shimmer** (the render+carousel-wiring was extracted into one
   function so it runs exactly once).
   - Cache **< 60 s old** → **return; zero Firebase reads.** (This is the rapid
     navigate-away-and-back case — now completely read-free and flash-free.)
   - Cache **60 s–10 min old** → paint from cache now, then revalidate **for the
     next visit only** (write fresh payload; **no re-render this view**, so no
     re-wiring and no flash). New promos appear on the following load.
3. **Cold path** (no/expired cache) → shimmer → fetch → mount → write cache. Same
   UX as before, but now it primes the cache so the *next* visit is instant.
4. **Lazy user resolution** (dashboard.html): the 4th arg is now a *provider function*,
   invoked only on a real fetch — so a warm load skips the banner's redundant
   `requireAuth()` + customer read entirely.

Fallback behaviour, targeting, impression/click tracking, image-error handling, swipe,
dots, and autoplay are all unchanged (the extracted `renderAndWire` is the old body
verbatim). "Update-in-place when the fresh payload differs from the shown one" is a
deliberate **non-goal here** (it requires a safe re-mount/teardown and browser
verification) — documented as Tier-2.

---

## 11. Dashboard restoration — before / after

| Section | Before (return visit) | After |
|---|---|---|
| Greeting / profile / avatar | instant (localStorage) | unchanged |
| Location | instant (localStorage) | unchanged |
| Nearby pros | instant (localStorage TTL) | unchanged |
| Popular services | instant (catalog) | unchanged |
| **Promo banner** | **shimmer → Firestore read → rebuild (flash)** | **instant paint from cache; ≤1 background read only if >60s stale; 0 reads on rapid return** |
| Notification badge | live subscription | unchanged |

---

## 12. Firebase read comparison (code-path estimate — NOT yet browser-measured)

Per **dashboard visit**, banner-attributable reads:

| Scenario | Before | After |
|---|---|---|
| First ever load (cold cache) | 1 `promotions` (+ `requireAuth` role read + 1 `customers`) | same (cold path primes cache) |
| Return **< 60 s** later | 1 `promotions` (+ role read + `customers`) | **0** (cache fresh; lazy provider not invoked) |
| Return **60 s–10 min** later | 1 `promotions` (+ role read + `customers`) | 1 `promotions` in **background**, applied next load; instant paint; no `customers`/role read on the paint path |
| Rapid A→B→A→B navigation | N × (read + role + customers) | ~0 for the banner while cache is fresh |

> **Honesty note:** these are derived from tracing the code paths, not from a live
> `onSnapshot`/`getDocs` counter. **Do not report the issue "measured-solved" until a
> browser instrumentation pass (§16) confirms it.** The cache *logic* is unit-verified
> (§14); the *read reduction* is reasoned.

---

## 13. Files changed

| File | Change |
|---|---|
| `shared/js/services/persistentCache.js` | **NEW** — canonical versioned/TTL/uid-scoped navigation-surviving cache. |
| `customer-app/js/adBanner.js` | Import cache; add SWR `mountAdBanner` (instant-paint, stale-time, lazy user); extract carousel body into `renderAndWire` (single-mount invariant). Rendering/fallback/tracking logic unchanged. |
| `customer-app/dashboard.html` | Banner mount passes a **lazy user provider** instead of an awaited user, so a warm load does no redundant auth/customer read. |
| `docs/CUSTOMER_APP_PERFORMANCE_AUDIT.md` | This report. |

No changes to auth logic, Firestore rules, repositories, financial flows, navigation
targets, or visual design.

---

## 14. Tests performed

- **Unit — persistentCache (11/11 pass):** hit returns data + `ageMs`; `version`
  bump invalidates; different `uid` misses; TTL expiry misses; absent key misses;
  local/session isolation; `uid=null` round-trips; `invalidate` clears; corrupt JSON
  degrades to a clean miss.
- **Syntax:** `node --check` on both files; repo `check-syntax` gate (150 JS + 85
  inline scripts) → *"Everything parses."*
- **Regression guard:** design-token lint unchanged at 322 (dashboard edit token-clean).
- **Reasoned invariants:** single-mount (no listener duplication); financial data
  never cached; auth gating unchanged (authInit still calls `requireAuth`).

**Not yet done:** live browser read-count instrumentation; slow/offline/expired-session/
corrupted-cache/multi-tab/rapid-switch matrix (§16).

---

## 15. Remaining risks

- **Structural (RC1):** full-document navigation still tears down the DOM; the banner
  now *looks* instant, but the page is still a cold load. True persistence needs an
  app shell (Tier-3, gated).
- **Stale promos up to 10 min** (or until next load) — acceptable for non-sensitive
  marketing; TTL + `version` bound it.
- **Read-count claim is estimated**, not measured (§12).
- **RC4 not fully closed** — auth is still resolved more than once per page in the
  general case; only the banner's redundant call was made lazy.

---

## 16. Gated roadmap (recommend; not executed here)

**Tier 2 — consolidation (medium risk):**
1. **Session singleton** — resolve auth+role **once** per page in a `sessionService`
   and hand the user to every consumer (closes RC4). Touches the auth guard → verify
   RBAC before/after.
2. **Migrate the bespoke caches** (nearby pool, profile paint, location) onto
   `persistentCache` for one key format + versioning.
3. **In-flight dedup** in `cachedDatabaseService` — share the pending promise for
   concurrent identical reads.
4. **Live instrumentation harness** — a dev-only `onSnapshot`/read counter to produce
   the real before/after numbers §12 estimates, plus the slow/offline/expired/
   corrupted/multi-tab test matrix.

**Tier 3 — structural (higher risk, gated):**
5. **App-shell / History-API navigation** for the core tabbed screens (dashboard ↔
   bookings ↔ notifications ↔ profile) so returning is a true in-place restore, not a
   cold load — *without* a framework, preserving every deep-link/back/refresh path.

Each item should be greenlit and verified individually; none should be batched into a
single sweep (auth + financial surfaces are involved).

---

## 17. Rules for future developers (prevent regression)

1. **A new dashboard/home section that reads Firestore MUST instant-paint from
   `persistentCache` (or an existing localStorage cache) and revalidate — never
   shimmer-then-fetch on every load.** The banner regressed precisely because it
   skipped this.
2. **Never cache financial/booking/security data** (wallet, payment, escrow, live
   status) — real-time subscriptions only. `persistentCache` is presentation-data only.
3. **Version every cached schema** (`version:` arg). Bump it when the shape changes;
   old entries self-discard.
4. **uid-scope any per-user cache** (`uid:` arg) — no cross-account leakage.
5. **Resolve auth once.** Don't add another `requireAuth()`; consume the session the
   page already resolved (and pass a *lazy* user provider to anything that only
   sometimes needs the user).
6. **A carousel/section that can re-render must not re-attach `document`/`window`
   listeners** — keep the single-mount invariant, or add explicit teardown.
7. **Use `pagehide`, not `unload`** (keeps bfcache eligibility) and unsubscribe every
   `onSnapshot` there.

---

*Companion to `docs/design-system/PHASE1_CUSTOMER_APP_AUDIT.md`. The performance work
here is the data-lifecycle analogue of that design-system audit.*
