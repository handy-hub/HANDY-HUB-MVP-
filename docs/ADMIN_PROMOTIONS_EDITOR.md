# Admin Promotions Manager — Audit & Build Report

**Question asked:** Does a working promotions-management interface already exist in the
Handy Hub Admin App? If yes, repair it; if no, build one.
**Answer:** **No editor existed** — only a temporary seed script. A complete manager was
built at `admin-dashboard/promotions.html`.
**Verification status:** Static + logic verification done (syntax gate, 18-case delivery-state
unit test, schema trace against the customer app). **Live Firebase end-to-end was NOT run**
(the admin app is auth-gated and needs a real admin session + browser) — a test checklist is in §11.

---

## 1. Admin files discovered

`admin-dashboard/`: `index.html` (overview), `analytics/artisans/customers/verifications/
bookings/disputes/finance/payouts` pages, `login.html`, **`seed-promotions.html`**, and
`js/{firebase-admin,auth-guard,ui-utils}.js` + `css/admin.css`.

| Concern | Finding |
|---|---|
| Existing promotions UI | **None.** `seed-promotions.html` is a self-labelled *"TEMP … Delete this file after use"* one-shot that writes 4 hardcoded promos. No list, edit, preview, schedule, target, activate, or delete UI. |
| Firebase | `js/firebase-admin.js` — named app `handy-hub-admin`, **`db = getFirestore(app, 'ai-studio-5589039d-…')`**. |
| Auth | `js/auth-guard.js` `initAdminPage(onReady)` — `SUPER_ADMIN_EMAILS` allowlist, else `admins/{uid}.status=='active'`. |
| Design system | `css/admin.css` — full token set + `.admin-table`, `.badge*`, `.btn*`, `.chip`, `.table-toolbar`, `select.admin-select`, `.modal*`, `.skel`, `.admin-toast`. |
| Shared UI | `js/ui-utils.js` — `showToast`, `esc`, `fmtNum` (toast host `#admin-toast`). No native `alert/confirm` in use. |

---

## 2. Defects / risks found during the audit

1. **No manager** — promotions could only be edited by hand in the Firestore console or by re-running the temp seed. *(Fixed — built.)*
2. **Stale seed data** — `seed-promotions.html` writes `action.value: 'book-step1.html'`, a route **deleted in the booking rebuild**. Any customer tapping those seeded promos hits a dead route. *(Flagged; the new editor's route picker excludes `book-step*` and marks unknown values `⚠ unknown`.)*
3. **`category` action dead-ends** — the customer resolver sends `category` taps to `browse.html`, which is **not a current customer page**. *(The editor supports the type for completeness but warns and steers to Service/Route.)*

**Explicitly checked and found CORRECT (not defects):**
- **Database alignment** — customer `FIRESTORE_DB_ID` **===** admin `ADMIN_DB_ID` **===** `ai-studio-5589039d-…`. Admin writes and customer reads hit the **same** database. ✔
- **Security rules exist and are complete** (`firestore.rules:1155-1205`): `promotions` read=signed-in, create/update=admin, **delete=super-admin**; `promotionAnalytics` read=admin, create/update=any signed-in user **but strictly +1** to impressions/clicks, delete=super-admin. **Not weakened.** ✔
- **Analytics engine** — `promotionService.js` increments `promotionAnalytics/{id}` via `FieldValue.increment(1)`; the customer dedups impressions per mount (a `Set`) and fires clicks per tap. Rules cap every write at +1, so counters can't be arbitrarily inflated. No verified defect → **not rewritten**. ✔

---

## 3. Files changed

| File | Change |
|---|---|
| `admin-dashboard/promotions.html` | **NEW** — the full promotions manager (list + editor + preview + lifecycle + analytics). |
| `admin-dashboard/index.html` | Added a **Marketing → Promotions** sidebar link so it's reachable from the hub. |

No changes to Firestore rules, Cloud Functions, the customer app, `adBanner.js`, `promotionService.js`, the caching layer, or `seed-promotions.html`.

---

## 4. Administrative workflow now possible (no Firestore console)

List every promotion → **New/Edit** in a modal with live preview → set content, image, action,
targeting, schedule, priority, social proof, status → **Save** (writes the exact nested schema) →
**Activate/Deactivate**, **Duplicate** (as draft), **Archive** (any admin) or **Delete** (super-admin).
Search by title; filter by delivery state; sort by priority/impressions/clicks/CTR/title.

---

## 5. Firestore schema written (byte-for-byte the customer contract)

```js
promotions/{autoId} = {
  status: 'draft' | 'active' | 'inactive',
  content: { tag, title, subtitle, body, cta },
  media:   { imageKey },                 // Cloudinary public_id or null
  color,                                 // CSS colour/gradient or null
  action:  { type, value },              // type ∈ service|artisan|route|external|promo|category
  targeting: { cities:[], serviceTypes:[], newUsersOnly:false },
  schedule:  { start:ISO|null, end:ISO|null, priority:number },
  clients:   { count, label, avatars:[{initial,color}] } | null,
  analytics: { impressions:0, clicks:0 },// display-only parity with the seed; NOT authoritative
  createdAt, createdBy, updatedAt, updatedBy   // audit fields (ignored by the customer)
}
```

Edits use a **full-document `setDoc`** (preserving `createdAt` + display `analytics`) so no stale
nested sub-field can survive. Lifecycle toggles use a minimal `updateDoc({status,…})`. Schedule
values are stored as ISO strings — `promotionService.toMillis()` already accepts ISO, ms, and
Firestore Timestamps, so they resolve identically on the customer.

---

## 6. Delivery-state logic (computed, not raw `status`)

`deliveryState(p)` returns one of **Invalid → Draft → Inactive → Scheduled → Expired → Active**,
derived from `status` + `schedule.start/end` + required-field validity + action validity — the
exact eligibility inputs the prompt required. It mirrors `promotionService.resolvePromotions`'s
window logic. A separate **"In rotation / Queued #n"** tag estimates the top-3 priority cap
(targeting-agnostic, since true visibility is per-user). **Unit-tested: 18/18 cases pass.**

---

## 7. Cloudinary handling (and the 404 root cause)

- **Root cause of the 404s:** on-the-fly **transformed** delivery is blocked on this Cloudinary
  account (a **Strict-Transformations / account-security setting** — even a bare `w_160` resize
  fails; the **untransformed original always resolves**). This is documented in
  `cloudinaryService.js:78-92` and is **account configuration, not app code** — the app-side fix
  is to enable unsigned/allowed transformations (or add a backend signer) in the Cloudinary
  dashboard. The customer banner already sidesteps it by delivering the untransformed original
  (`cdnUrl(imageKey, '')`) and letting CSS crop.
- **The editor matches that exactly:** it stores a **`public_id`** in `media.imageKey` (never a
  URL), uploads via the unsigned **`hh_banners`** preset (`uploadImage` → returns `public_id`),
  and **validates deliverability** by loading `cdnUrl(key,'')` — showing ✔ resolves / ⚠ falls back
  to colour. Publishing an unresolved image is **allowed on purpose** (colour fallback) but is
  **never silent** — the warning is always on screen. Empty `imageKey` = intentional colour banner.

---

## 8. Preview architecture

The live preview reuses the **exact** customer markup (`.slide-content/.ad-tag/.slide-title/…`),
the exact CSS values copied from `customer-app/css/dashboard.css`, the same `cdnUrl(key,'')` image
resolution, the same CTA/client-widget treatment, and the same image-error → colour-fallback
behaviour. It is a faithful mirror, not a stylised mock. *(Limitation: it is a copy, so if the
customer banner CSS changes it must be re-synced — noted in §10.)*

---

## 9. Validation · permissions · caching · states

- **Validation:** title required; action value required (+ `http(s)://` for external); end-after-start
  enforced; unknown routes flagged; category warned; datetime and priority typed. Save is blocked
  on invalid input with inline field errors.
- **Permissions:** page is `initAdminPage`-gated; writes rely on the **existing** Firestore rules
  (admin create/update, super-admin delete). **Non-super admins cannot hard-delete** → the UI offers
  **Archive** (status→inactive) instead, and a `permission-denied` on delete is surfaced clearly.
  No rules weakened, no Cloudinary secret exposed (unsigned preset only), no client-role-only checks.
- **Caching:** the page shows a standing notice that customers may see a cached banner for **~10 min**
  (background revalidation ~60s) — **no false "instant" promise**. The admin does **not** weaken the
  customer SWR cache; the existing bounded delay is preserved (no cache-version marker added, to avoid
  extra customer reads).
- **States:** loading row, empty state, per-filter empty, error row, toast success/error, disabled
  save while in flight (duplicate-submission guard), confirm modal for destructive actions
  (no native `confirm()`).

---

## 10. Tests performed

- **Repo syntax gate** (`check-syntax.cjs`): 86 inline scripts across 59 HTML files → *"Everything parses."*
- **`node --check`** on the extracted 590-line module → parses.
- **Delivery-state unit test (18/18 pass):** invalid (no title / empty value / bad type), draft,
  inactive, archived→inactive, scheduled (future start), expired (past end), active (in-window &
  window-less), `toMillis` (ISO/number/null), targeting summaries.
- **Schema trace:** the written object matches `adaptPromotion()` + `resolvePromotions()` field-for-field.

**NOT yet run (requires a live admin session + browser):** create→appears-for-eligible-customer,
targeting exclusion, each action type end-to-end, real Cloudinary upload/delivery, impression/click
analytics accrual, cache-expiry disappearance, and the fallback-slides path. See §11.

---

## 11. Live E2E checklist (for an authorised admin to run)

1. Open `promotions.html` as an admin → list loads (or empty state).
2. **Create** a draft → confirm preview matches → **Activate** → check `promotions/{id}` in Firestore has the nested shape from §5.
3. On a customer device in an eligible city / new-user state → confirm it appears in the banner (allow ≤10 min or hard-refresh).
4. Set `targeting.cities=['Accra']` → confirm a non-Accra customer does **not** see it.
5. Set a **future** start → state shows *Scheduled*, not shown; set a **past** end → *Expired*.
6. Create 4 active promos with different priorities → only the top 3 show; the 4th reads *Queued #4*.
7. Upload a real image → ✔ resolves; type a bogus `public_id` → ⚠ warning + colour fallback in preview and on the customer.
8. Exercise every action type; verify the tap lands correctly (skip `category` → `browse.html`).
9. Tap a promo on the customer → `promotionAnalytics/{id}.clicks` increments by 1; views increment impressions.
10. **Deactivate** → confirm it disappears after cache expiry/revalidation.
11. As a **non-super** admin, confirm Delete is replaced by **Archive**; as super-admin, confirm hard delete works.
12. **Fallback test (dev only):** set all promos inactive (or simulate a Firestore read failure) → confirm the 3 hardcoded `BANNER_DATA` slides still render.

---

## 12. Remaining limitations

- **Live E2E unverified by me** (§10/§11).
- **Nav link** added to `index.html` + `promotions.html` only; the other admin pages duplicate their
  sidebar markup, so Promotions won't appear in their menus until propagated (existing tech-debt pattern).
- **`seed-promotions.html`** left untouched (temp utility) — recommend deleting or updating its
  `book-step1.html` action values.
- **`category` action type** targets the nonexistent `browse.html` — recommend removing the type or adding the page.
- **Preview CSS is a copy** of the customer banner — re-sync if `dashboard.css` `.slide*` changes.
- **`artisan` action value** is free text (not existence-checked against `artisans/{id}`) — a nice future validation.
- **No pagination** — fine for the expected low promo count; add if it grows large.

---

---

# Part 2 — Integration completion (2026-07-21)

Follow-up pass: the two flagged dead routes, resolver consolidation, nav propagation, and seed
deprecation. **Live authenticated E2E was still not run** — see §E2E below (unchanged status, stated
honestly, not marked done).

## Root causes of the two dead routes
- **`book-step1.html`** — a booking-flow page **deleted in the 2026-07-02 booking rebuild**; the seed
  data (and any promo authored against it) still pointed there. Nothing regenerates that file.
- **`browse.html`** — **never existed.** `adBanner.resolveAction`'s `category` branch used a
  placeholder default (`action.payload?.url ?? 'browse.html'`) that no page ever satisfied, so every
  `category` tap dead-ended.

## Canonical replacements (verified against the live customer flow)
- **`book-step1.html` → `book-request.html`** — the booking entry point every current page routes to
  (`dashboard.html:661`, `adBanner` service path, `booking/professionals/saved/nearbyPros`…).
- **Category destination → `book-request.html?cat=<id>`** — exactly how the dashboard opens a category
  (`dashboard.html:661`), resolved via `serviceCatalog.resolveCategory()` (id/label/key → `{id}`).
  `browse.html` is fully removed from the code paths.

## Shared action-routing contract (consolidation)
New **`shared/js/domain/promotionAction.js`** is now the single source of truth for every action
type's **destination**, **session side-effects**, and **validation**:
`promotionActionTarget()`, `isValidPromotionActionValue()`, `describePromotionActionDestination()`,
`PROMO_ACTION_TYPES`, `CUSTOMER_ROUTES`.
- `adBanner.resolveAction()` was **rewritten from a 6-case switch to a thin executor** of this
  contract; `adaptPromotion()` + `BANNER_DATA` now use the same `{ type, value }` shape (the old
  `{ type, payload }` mapping is gone). Admin preview, admin validation, and customer navigation now
  agree by construction.
- **Latent bug fixed in passing:** the old `adaptPromotion` mapped `promo` to `{code, url:value}`, so a
  Firestore `promo` action navigated to *the code as a URL*. The contract now enforces one meaning:
  **`promo` sets `hh_promo` then opens `book-request.html`.**
- Per-type destinations (canonical): `service`/`category` → `book-request.html?cat=<id>`; `artisan` →
  `artisan-profile.html` (+`hh_artisan_view`); `route` → the validated page; `external` → http(s) new
  tab; `promo` → `book-request.html` (+`hh_promo`). Invalid/empty values degrade to `book-request.html`,
  never a dead link.

## Editor validation hardened
`validAction`/`validate` now delegate to `isValidPromotionActionValue`, so the admin **cannot save**:
a `route` not in the registry (incl. `book-step1.html`), a non-`http(s)` external URL
(`javascript:`/`data:` rejected), or a `service`/`category` that doesn't resolve. The old
"⚠ may go to browse.html" note is replaced by a live **"Opens book-request.html?cat=…"** destination
readout under the action field.

## Seed tool changes
`seed-promotions.html`: both `book-step1.html` values → `book-request.html`; a strong **Deprecated**
banner added pointing to the authoritative Promotions manager. Left in place (not deleted — no policy
to), not in any sidebar, safe to re-run (fixed ids).

## Admin navigation propagation
**Marketing → Promotions** added to all **7** admin pages that use the shared sidebar: `index`,
`promotions` (active), `customers`, `disputes`, `bookings`, `artisans`, `verifications`. Active-state,
icons, and both sidebar markup variants (compact single-line and multi-line) preserved.
**Architectural debt documented:** the sidebar is **duplicated markup per page** (no shared partial),
and **`finance.html` is a divergent legacy page** — different nav system (`.nav-item`/`.sidebar-nav`,
`href="#"` dead links, older design tokens, `.main`). Promotions was **not** injected into finance's
broken nav; it needs a separate migration onto the standard shell.

## Permission handling (unchanged, re-confirmed)
`initAdminPage` gate + Firestore rules remain authoritative. Non-super admins get **Archive**; hard
**Delete** stays super-admin-only with a confirm modal. The nav link is visible to any admin (hidden
nav ≠ security; the rules enforce access).

## Analytics findings (traced, not live-measured)
The banner fires **at most one impression per shown slide per mount** (`_trackedImpressions` Set);
clicks fire per tap. With the SWR cache, a cached instant-paint still fires exactly one impression per
dashboard view (correct — the banner *was* shown), and stale-revalidation does **not** re-render, so no
extra impression. Rules cap every write at **+1**. **No duplicate-counting defect reproduced** →
analytics engine left unchanged, as instructed. *(Reproduction requires the live app.)*

## Cloudinary findings (unchanged)
Root cause = account **Strict-Transformations** blocking derived URLs; untransformed delivery works and
is what both the customer banner and the editor use. Nothing in the delivery path was changed.

## Caching observations (unchanged, preserved)
The customer SWR cache (≤10 min, ~60s revalidate) is untouched; the admin standing notice remains
accurate. No cache-version marker was added (would add customer reads for little gain).

## E2E scenarios — status: **NOT RUN (owed)**
The 20-step live sequence and the per-action valid/invalid matrix require an **authenticated admin
session + a browser + the customer app**, none of which are available in this non-interactive
environment. I did **not** run them and am **not** marking them passed. What was verified instead:
- **Logic-level (passing):** the shared action contract — **23/23** cases (every type's destination +
  valid/invalid validation, both dead-route fixes, the `promo` fix, `javascript:` rejection); the
  delivery-state machine — **18/18**; the persistent-cache SWR — **11/11** (prior pass).
- **Static:** `node --check` on `promotionAction.js`, `adBanner.js`, and the extracted 590-line
  promotions module; repo syntax gate (*"Everything parses"*, 151 JS / 86 inline); token lint
  unchanged (322).

The runnable checklist is §11 above. **These must be executed in a dev/staging admin session before
declaring the pipeline production-verified.**

## Files changed (Part 2)
`shared/js/domain/promotionAction.js` (**new**); `customer-app/js/adBanner.js` (resolver
consolidation + route fixes); `admin-dashboard/promotions.html` (shared contract, validation,
destination readout); `admin-dashboard/{index,customers,disputes,bookings,artisans,verifications}.html`
(nav link); `admin-dashboard/seed-promotions.html` (route fix + deprecation).

## Remaining risks / limitations
- **Live E2E unrun** (above) — the one gate that source inspection cannot close.
- **`finance.html`** off the shared nav (legacy) — needs its own shell migration.
- **Sidebar duplicated per page** — future nav changes still touch N files; a shared partial/injector
  would fix it (larger refactor, not in scope).
- Editing a legacy promo whose action is now invalid (e.g. a stray `route`) surfaces as **Invalid** and
  blocks re-save until corrected — intended, but worth knowing before a bulk edit.
- Preview CSS remains a copy of the customer `.slide*` styles (re-sync on change).

---

*Pairs with `docs/CUSTOMER_APP_PERFORMANCE_AUDIT.md` (the banner caching work this manager feeds).*
