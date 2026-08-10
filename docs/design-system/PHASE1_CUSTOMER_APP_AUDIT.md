# Handy Hub Customer App — Phase 1 Design System Audit

**Status:** Discovery & documentation only. No redesign, no code changes.
**Scope:** The Customer App (`customer-app/`) and the shared layer it consumes (`shared/`).
**Date:** 2026-07-17
**Method:** Source-of-truth read of the shared token + component layer; grep-quantified drift
across all 16–17 page CSS files; sampled page implementations; cross-checked against the two
existing design-system docs (`DESIGN-SYSTEM-CONTRACT.md`, `MODAL_DESIGN_SYSTEM.md`).

> **One-line verdict:** Handy Hub does **not** have an immature or accidental UI. It has a
> deliberately engineered, well-documented design-system *core* — and a long tail of ~40 legacy
> pages that predate that core and adopt it only partially. The problem is **migration debt, not
> design absence.**

---

## 0. Headline scores

| Dimension | Score /10 | One-line basis |
|---|---:|---|
| Token architecture (design foundation) | **8.5** | Single canonical `:root` in `ui-polish.css`; 4px spacing grid, radius/elevation/z/motion scales, semantic colours all defined. |
| Canonical component library (shared) | **8.0** | Modal, sheet, tabs, back-button, floating nav, page transitions all exist as documented single-source components with a11y baked in. |
| Motion system | **7.5** | Real named easing + duration tokens (`--ui-ease-*`, `--ui-dur-*`); reduced-motion honoured globally. Partly still hardcoded in pages. |
| Documentation / governance | **8.0** | Two contracts + a *measured* modal spec + a CI token lint. Rare at this stage. |
| **Adoption / consistency across pages** | **4.0** | 1,258 hardcoded hex + 590 hardcoded font-sizes vs 717 token refs in page CSS. This is the drag. |
| Component consolidation | **5.0** | 3 parallel modal engines, ≥6 sheet/dialog variants, 2 nav systems still coexist pending migration-on-touch. |
| Accessibility | **6.5** | 44px tap floor + focus-visible + reduced-motion + focus-trap in shared components; per-page contrast/labels unverified. |
| Responsiveness | **7.0** | Consistent phone-shell model (`≤430px`), desktop framing, safe-area handling in the shared layer. |
| **Overall UI Design System Maturity** | **6.4 / 10** | *"Strong core, half-migrated surface."* |

The system's ceiling is high (the foundation is genuinely good). The current experience is capped
by **inconsistent adoption**, not by the quality of the design language.

---

## 1. Architecture: the layer cake

The Customer App renders through **four CSS layers**, loaded in this cascade order:

```
1. shared/css/ui-polish.css      ← CANONICAL. The only file that defines token VALUES.
                                    Loaded on ~34/35 customer pages. @imports back-btn.css.
2. shared/css/components/*.css    ← Canonical components: modal, sheet, tabs, back-btn, swipeAction.
   shared/css/floatingNav.css       Single-source, token-driven, dark-mode + reduced-motion aware.
   shared/css/pageTransitions.css
3. customer-app/css/<page>.css    ← 16 per-page stylesheets. Where the design debt lives.
4. inline <style> + element style=  ← page-local overrides (present, not yet quantified per-page).
```

Two legacy files — `shared/css/variables.css` and `shared/css/global.css` — **are loaded by zero
pages** and self-document as dead. `variables.css` is a one-line tombstone; `global.css` still
contains ~1,200 lines of legacy component CSS (sidebar, ads, login, splash, toast) whose `:root`
token block was already stripped and re-pointed at canonical aliases. They are inert but not yet
deleted.

**Key insight for Phase 2:** the layers are correctly *ordered* (canonical first, page CSS last), so
page CSS can and does override tokens with literals. Fixing adoption is therefore mostly a
**subtractive** exercise (replace literals with the tokens that already exist), not an additive one.

---

## 2. Visual identity & design philosophy

**There is a coherent, intentional design language.** It is not an accident of independent page
evolution — the same personality recurs everywhere:

- **Brand:** a single deep maroon `--ui-primary: #730201` with a soft tint `--ui-primary-soft:
  #fde8e8`. Maroon is used sparingly for primary action, active nav, and accents — not as flood fill.
- **Canvas:** near-white `--ui-bg: #fefefe` (documented brand background standard) with white raised
  surfaces `#ffffff` and a quiet inset grey `#f5f5f5`.
- **Shape language:** soft, rounded, friendly — a 3-step radius scale (10/14/18px) plus a pill
  (999px). Corners are consistent enough that the app reads as one product.
- **Depth:** restrained. The elevation scale prefers **spacing and hairline borders over heavy
  shadow** (a stated principle), with only 4 elevation levels.
- **Motion:** a signature "emphasis" ease `cubic-bezier(0.22, 1, 0.36, 1)` gives entrances a
  confident settle; a spring curve powers the floating nav's playful icon "land."
- **Surface treatment:** selective *liquid-glass* (backdrop-blur) on the floating nav and toast —
  a premium, modern flourish used as a signature, not everywhere.

**Personality:** modern, warm, consumer-focused, trustworthy, mobile-first. It reads closer to a
premium consumer marketplace app (think ride-hail / delivery) than an enterprise tool. The
aspiration is clearly "premium and friendly."

**Where the personality fractures:** on legacy pages that never adopted the tokens, the same screen
can carry cooler greys, different radii (16px vs 18px), heavier shadows, and a competing font
import. The *intent* is uniform; the *execution* drifts page to page.

---

## 3. Design token system

**Source of truth:** `shared/css/ui-polish.css` `:root` (lines 19–152). This is genuinely strong.

| Group | Tokens | Assessment |
|---|---|---|
| Surfaces / ink | `--ui-bg` `--ui-surface` `--ui-surface-2` `--ui-text` `--ui-muted` `--ui-faint` `--ui-border` `--ui-border-2` | ✅ Complete 3-level surface + 3-level ink model. |
| Brand | `--ui-primary` (+`-rgb`, `-soft`, `-dark`) | ✅ Single brand source. |
| Semantic | `--ui-danger` `--ui-success`(+bg) `--ui-warning`(+bg) `--ui-overlay` | ✅ Functional colours defined and RGB-decomposed for alpha. |
| Spacing | `--ui-1…--ui-10` (4/8/12/16/20/24/32/40) + `--ui-gutter` | ✅ True 4px grid. |
| Radius | `--ui-radius-sm/md/lg/pill` (10/14/18/999) | ✅ Disciplined 3+1 scale. |
| Elevation | `--ui-elev-0…3` + back-compat `--ui-shadow-sm/md` | ✅ 4-level scale; functional shadows explicitly excluded (rings/glows keep own values). |
| Z-index | `--ui-z-base…toast` (0/100/200/500/800/1000/2000) | ✅ Named layer scale. |
| Motion | `--ui-ease-emphasis/exit/spring` + `--ui-dur-instant…sheet` | ✅ Real curves + 5 durations. |
| Modal type scale | `--ui-modal-title-*` `--ui-modal-body-*` `--ui-modal-pad-*` | ✅ Modal typography tokenized. |
| Layout | `--ui-shell-max` (430) `--ui-shell-max-wide` (480) | ✅ Phone-shell constants. |
| Nav bridge | `--nav-brand`(+`-rgb`,`-dark`) | ✅ Clean indirection so artisan app can re-skin the shared nav without touching `--ui-primary`. |

**Governance exists.** `DESIGN-SYSTEM-CONTRACT.md` forbids new `:root` blocks in page CSS, forbids
hardcoded brand hex, forbids the artisan `--ds-*` namespace in the customer app, and there is a CI
lint (`scripts/design-token-lint.cjs`, referenced in project memory).

**Weaknesses:**
- **Legacy aliases still live** (`--maroon`, `--primary-red`, `--secondary-bg`, `--text-dark`,
  `--bg-page`, `--unread-bg`, …). They resolve to canonical values, so they're harmless visually,
  but they keep two vocabularies alive and let old code look "tokenized" while bypassing the real names.
- **Two dark-mode conventions coexist:** the customer app historically toggles `html.dark`
  (see `global.css` dark block, ~lines 2085–2190), while the canonical components target
  `[data-theme="dark"]`. `tabs.css` deliberately supports *both* — evidence of an unfinished
  migration, and a trap for any new component that only handles one.

---

## 4. Typography architecture

- **Family:** `DM Sans` (Google Fonts) with a system-font fallback stack. **One typeface app-wide** —
  good. But the `@import` for DM Sans is **repeated per page** (e.g. `dashboard.css:1`,
  `global.css:1`) rather than linked once, and a few legacy blocks still name `'Segoe UI'` /
  `'Noto Sans'` (`global.css` banners/branding). So the *intended* family is uniform; the *loading*
  is duplicated and a few stragglers escape it.
- **Modal type scale is tokenized** (`--ui-modal-title-size: 18px/800`, body `13.5px/1.55`). This is
  the only part of the type system that is truly a *scale*.
- **Everywhere else, type is ad hoc.** `grep` finds **590 hardcoded `font-size` values** across 16
  page CSS files (`style.css` 74, `booking-flow.css` 127, `dashboard.css` 83, `book-now.css` 81…).
  Sizes cluster at 9/10/11/12/13/14/15/17/18/20/22px but with no named ramp — the same semantic role
  (e.g. a card title) is 13px on one screen and 15px on another.
- **iOS zoom guard is handled well:** `ui-polish.css` floors all text inputs at `max(16px, 1em)` to
  stop Safari's focus-zoom — a thoughtful, system-level fix.

**Verdict:** one font, one *modal* scale, and otherwise no typography scale. This is the single
biggest source of "similar screens feel subtly different."

---

## 5. Spacing & layout system

- **A real 4px spacing scale exists** (`--ui-1…--ui-10`) and a page gutter token. But page CSS
  overwhelmingly uses **raw px** for margins/paddings rather than the scale.
- **Phone-shell model is consistent and good.** `ui-polish.css` centralises shell classes
  (`.app`, `.phone-shell`, `.bn-shell`, `.bk-shell`, `.ms-shell`, `.sv-shell`, `.em-shell`,
  `.notif-page`) at `max-width: 430px` (or 480 for `.app`), with `overflow-x: hidden`,
  `overscroll-behavior: contain`, and single-line ellipsis on a curated set of title classes.
- **Safe areas are respected** in the shared layer (`env(safe-area-inset-bottom)` on nav, sheets,
  modals). Desktop gets a framed "device" look ≥768px (rounded 28px shell + shadow); phones drop to
  edge-to-edge. This responsive framing is centralised — a real strength.
- **Bottom-nav clearance** is centrally enforced (`.hh-has-fnav` adds `96px` padding).

**Weakness:** because pages don't consume the spacing tokens, vertical rhythm varies. The *structure*
(shells, safe areas, gutters) is systematized; the *interior spacing* is not.

---

## 6. Colour system

- **Semantically complete at the token layer** (§3): brand, danger, success, warning, overlay, three
  surfaces, three inks, borders. RGB decompositions exist for alpha compositing.
- **Massively under-consumed at the page layer.** `grep` finds **1,258 hardcoded hex colours** across
  17 page CSS files (`dashboard.css` 231, `book-now.css` 198, `topup.css` 133, `settings.css` 102,
  `profile.css` 91, `booking-flow.css` 91…). Even the *reference* screen `dashboard.css` mixes tokens
  (`var(--ui-primary)`, `var(--ui-elev-3)`, `var(--ui-surface-2)`) with literals
  (`#fefefe`, `#fff`, `#111`, `#777`, `#bbb`, `#f0f0f0`, `#f8f8f8`, `#fde8e8`) in the same file.
- **Grey sprawl is the specific problem.** The neutrals `#111 / #333 / #444 / #555 / #666 / #777 /
  #888 / #999 / #ccc / #eee / #f0f0f0 / #f5f5f5 / #f8f8f8` all appear as literals where 3 ink + 3
  surface tokens would cover them. `booking-flow.css` even documents *sanctioned* local greys
  (`--bf-text #111827`, `--bf-sub #6B7280`) that are cooler than the canonical neutrals — a small,
  intentional divergence that nonetheless makes booking screens read a shade different.
- **Brand-hex leakage:** the contract forbids raw `#730201`, but soft-tint literals like `#fde8e8`,
  `#fff5f5`, `#fdf2f2` recur instead of `var(--ui-primary-soft)` + alpha.

**Verdict:** the palette is coherent by design and fragmented in practice. This is the highest-volume,
lowest-risk Phase 2 win.

---

## 7. Component inventory

### 7.1 Canonical, production-grade (in `shared/`)

| Component | Files | State |
|---|---|---|
| **Back button** | `components/back-btn.css` | ✅ ONE circular 44px treatment; 8 legacy class names aliased into it; artisan `.ds-back-btn` variant. |
| **Centred dialog** | `components/modal.css` (`.ui-modal*`) | ✅ Icon disc, title/body scale, primary/danger/ghost buttons, input, dark mode, reduced motion. |
| **Bottom sheet** | `components/sheet.css` + `components/sheet.js` (`openSheet()`) | ✅ Best component in the app: focus trap, scroll-lock counting, swipe-dismiss via one engine, keyboard-inset tracking, multi-step morph, stacking. |
| **Filter tabs** | `components/tabs.css` (`.ui-tabs`) | ✅ 3 variants (pill/underline/segmented), badge, artisan skin, both dark conventions, 44px floor. |
| **Floating nav** | `floatingNav.css` (`.hh-fnav`) | ✅ Liquid-glass pill, spring icon-land, badge, emergency action, dark obsidian variant, `backdrop-filter` fallback, reduced motion. |
| **Page transitions** | `pageTransitions.css` | ✅ Slide-in-left/right, reduced-motion safe. |
| **Swipe action** | `components/swipeAction.css` + `.js` | ✅ Shared swipe-to-reveal for list rows. |
| **Security PIN sheet** | `components/securityPinSheet.js` | ✅ Reusable financial-auth checkpoint (documented). |
| **Financial auth sheet** | `components/financialAuthorizationSheet.js` | ✅ State machine (waiting/approved/failed/…) over `openSheet()`. |
| **Toast** | `components/toast.js` + styles in `global.css` | ✅ Liquid-glass toast with success/error/info accents; but styles live in the *dead* `global.css`, not a component file. |

### 7.2 Design-system gaps (no canonical component yet)

These recur across pages but have **no shared implementation** — each page re-invents them:

- **Buttons (non-modal).** There is *no* general button component. Primary CTAs are re-declared
  per page (`.login-btn`, `.btn-primary`, `.book-now`, `.enable-btn`, `.chat-btn`, `.view-more-btn`,
  `.sv-empty-btn`, `.uc-topup`, `.pc-book`…). `ui-polish.css` retrofits a shared *tap-target*
  ruleset over a hand-listed set of these class names (lines 327–345) — proof the fragmentation is
  known and being patched from outside rather than unified. **A `.ui-btn` primary/secondary/ghost/
  danger + size variants is the biggest missing primitive.**
- **Inputs / form fields.** No canonical text field. `.input-group input`, `.input-signup input`,
  `.search input`, `.ui-modal-input`, and per-page inputs each define their own height (50/52px),
  radius (8/12px), icon inset, and label style. Global rules only guarantee `min-height: 44px` and
  the 16px zoom floor.
- **Cards.** No unified card. At least: service card (`.cards`/`.c-one`), `.sv-svc-card` /
  `.sv-pro-card`, notification `.notif-card`, booking `.bk-card`, sidebar active-booking, promo
  `.sv-promo`, wallet/transaction cards. `ui-polish.css` documents a *convergence* effort — several
  cards were flattened onto the Notification "divided-row" pattern — but it's mid-flight.
- **Chips / tags / badges.** `.cat-btn`, `.search-tag`, `.tab-item .badge`, `.ui-tab-badge`,
  `.hh-badge`, `.hh-fnav-badge`, `.sidebar-menu-badge`, `.notification-badge` — many independent
  pill/badge treatments.
- **Empty / loading / skeleton states.** `.sv-empty` is a nicely designed empty state; loaders exist
  (`fastLoader.js`, `loader.js`, `#search-loader`). But there is no shared empty-state or
  skeleton component, so treatments differ per screen.
- **List rows, avatars, rating/review, banners, segmented controls** — all per-page.

**Reuse frequency signal:** the token layer is referenced 717 times in page CSS, but the *components*
(buttons/inputs/cards) that would carry those tokens don't exist as shared code — so pages hand-build
them and reach for literals. Closing the component gap is what will make token adoption "stick."

---

## 8. Modal / sheet / popup architecture

This is the most-documented and most-fragmented area. `MODAL_DESIGN_SYSTEM.md` is a *measured*
canonical spec and even ships its own "non-canonical inventory." My read confirms it and extends it.

**Canonical (approved):**
- `.ui-sheet` + `openSheet()` — the default idiom (mobile-first).
- `.ui-modal` — centred dialog for short/binary/destructive confirmations.
- `openSecurityPinSheet()` / `openFinancialAuthorizationSheet()` — financial auth.

**Non-canonical, still live (migrate-on-touch):**

| Implementation | Divergence |
|---|---|
| `shared/js/components/modal.js` (`#hh-modal-*`) | **Third modal engine.** Injects its own styles (rem-based type, `0.18s/0.2s ease` — *not* the signature curve), singleton (no sequential flows). `modal.css` claims to replace it; the swap never happened. |
| `customer-app/js/pages/paymentMethodsModal.js` | radius 28px, dur 0.38s, scrim 0.45, maxW 480, z 1900/1910, **no focus trap, no Escape**, native `confirm()`. |
| `customer-app/css/quote-modal.css` | scrim 0.55, exit-curve used on *enter*, references `var(--surface)` / `var(--surface-2)` **tokens that don't exist**, hardcoded font-family, `display:none` toggle (no transition). |
| `customer-app/css/settings.css` `.modal-*` / `.bottom-sheet` | Token-aligned clone of `.ui-modal--sheet` / `.ui-sheet`; **but** danger button uses `--ui-primary` not `--ui-danger`; redundant sheet clone. |
| `customer-app/css/personal-Info.css` `.modal` | `position: absolute` (not fixed), dur 0.3s. |
| Global "modal normalization" block (`ui-polish.css` ~L457–549) | **Remediation layer** that force-lifts legacy modals to `z-index: 1900/1910 !important`, overriding the `--ui-z-*` scale. Means the canonical sheet (800) can render *below* a legacy modal until every consumer migrates. |

Consumers found via grep (`sched-modal|em-modal|am-sheet|wd-sheet|pmo-sheet|quote-modal|delete-modal|
ui-modal|hh-modal|ui-sheet`): 10 files across `transaction-history`, `settings`, `professionals`,
`personal-Info`, `booking-flow`, `quoteModalService.js`, `paymentMethodsModal.js`.

**Behaviour consistency:** the canonical path has an excellent, non-negotiable behaviour contract
(backdrop/swipe/Escape dismiss, focus trap + restore, scroll-lock counting, keyboard inset, safe
area, reduced motion, opacity-scar guard). The legacy path has **none of it guaranteed** —
`paymentMethodsModal` and `quote-modal` notably lack focus trap / Escape. So *destructive and
financial* confirmations are inconsistent in exactly the flows where rigor matters most.

---

## 9. Motion / animation system

**A shared motion language exists at the token level** (`--ui-ease-emphasis/exit/spring`,
`--ui-dur-instant…sheet`) and the canonical components use it. Notable motifs:

- **Signature enter/settle** `cubic-bezier(0.22, 1, 0.36, 1)` on modals, sheets, page transitions.
- **Spring** `cubic-bezier(0.34, 1.56, 0.64, 1)` for the floating-nav rise, icon-land, badge-pop.
- **Sheet gesture physics** (documented): dismiss at 38% height or velocity >0.45px/ms, rubber-band
  ×0.12, scrim fades with drag.
- **Global reduced-motion** kill-switch in `ui-polish.css` and every component — a real a11y win.
- **Global transition defaults** on interactive elements (`a, button, [class*="btn"], .nav-item,
  .chip …`) so hover/press feel uniform where classes match.

**Fragmentation:**
- Page CSS still hardcodes curves/durations that predate the tokens (`0.3s ease`, `0.35s cubic-
  bezier(0.25,0.46,0.45,0.94)`, `0.2s`, etc.) — the sidebar, ads slider, and legacy modals each
  invented timings.
- **Two page-transition mechanisms:** the CSS `pageTransitions.css` (0.24s slide) and a JS
  `pageTransition.js` controller — need to confirm they're one system, not two.
- The **ads auto-slider** in `global.css` defines the `@keyframes slide` animation **twice**
  (lines 702 and 714), the second silently overriding the first — a literal dead-code motion bug.
- Decorative vs functional: most motion is functional (feedback, spatial continuity). The clearest
  "decoration only" is the auto-rotating ad carousel.

---

## 10. Navigation language

- **Primary nav:** a **floating glass pill** (`.hh-fnav`, `floatingNav.js`) — Home / Search / (Emergency) / Bookings / Profile, with active-glow, badge, spring icon-land. This is the modern, intended system.
- **Legacy nav:** a flat `.bottom-nav` bar still defined in `global.css` **and** re-centred/enforced
  in `ui-polish.css` (lines 385–418). So **two bottom-nav systems** coexist; `ui-polish.css` works
  hard to make the legacy one behave (fixed centering, 72px min-height, blur). Which pages use which
  needs a page-by-page confirm — this is a real "where am I / relearn" inconsistency risk.
- **Back navigation:** unified — one circular 44px back button, 8 legacy class names aliased in.
- **Contextual nav:** headers are per-page (`.hh-hdr`, `.sv-header`, `.bk-header`, `.ms-*`) but share
  the icon-button sizing rules from `ui-polish.css`.
- **Sidebar/drawer:** a full slide-in sidebar (profile, quick actions, menu, grow-card, logout) — but
  it's defined in the **dead** `global.css` at 300px *and* re-defined in `dashboard.css` at 285px.
  Two sidebar implementations with different widths.
- **Emergency modal** is globally available from the nav (`floatingNav.css` `.em-modal-*`).

**Verdict:** back-nav and primary intent are unified; the coexistence of legacy `.bottom-nav` +
`.hh-fnav`, and two sidebars, are the navigation-consistency risks.

---

## 11. Page taxonomy & cross-page consistency

Pages by family (from the file map + routing):

- **Auth / onboarding:** `index`, `splash-screen`, `login`, `signup`, `verify-email`.
- **Home / discovery:** `dashboard`, `search-page`, `search-not-found`, `services`, `professionals`,
  `artisan-profile`, `saved`.
- **Booking:** `book-request`, `book-emergency`, `quote-approval`, `booking`, `live-tracking`,
  `review`. (Note: `book-now`/`book-step*`/`service-detail` were deleted in the 2026-07-02 fresh
  start; `book-now.css` / `booking-flow.css` still exist as CSS.)
- **Money:** `topup`, `payment`, `transaction-history`.
- **Comms:** `messages`, `notification`.
- **Account:** `profile`, `settings` + 9 settings sub-pages (personal-info, security, notifications,
  privacy, location, help, about, terms, privacy-policy).

**Consistency findings:**
- **List pages diverge then converge:** Notification's flat divided-row card is being adopted as the
  canonical list pattern (`saved`, some booking/service cards were flattened onto it per
  `ui-polish.css` comments) — a good direction, mid-migration.
- **Settings family** shares an architecture but ships **its own** `.modal-*` and `.bottom-sheet`
  clones instead of the canonical ones.
- **Booking family** carries the cooler `--bf-*` local palette and 16px radius, so it reads a shade
  different from the 18px maroon-neutral rest of the app.
- **Money family** (`topup`, `payment`, `transaction-history`) is where the strongest canonical work
  landed (security PIN + financial-auth sheets, topup receipt as the reference full-screen success),
  yet `paymentMethodsModal` remains a non-canonical outlier in the same family.
- **Empty states** are inconsistent: `.sv-empty` is polished; other screens' empty/zero states are
  ad hoc.

**Rule of thumb the audit confirms:** a user who learns one *canonical-era* screen (dashboard,
notifications, topup) will understand its siblings; a user who then hits a *legacy-era* screen
(settings modals, quote modal, payment-methods modal) meets slightly different interactions.

---

## 12. Accessibility (design-system lens)

**Strengths (built into the shared layer):**
- `:focus-visible` ring on all interactive elements (`global.css`, and per-component).
- **44px tap-target floor** enforced centrally in `ui-polish.css` over a curated class list, plus
  44px minimums on tabs and back button.
- **Focus trap + focus restore** in `modal.js`, `sheet.js`, and the PIN sheet.
- **Reduced-motion** honoured globally and per-component.
- **iOS input-zoom guard** (16px floor).
- ARIA scaffolding in canonical components (`role="dialog"`, `aria-modal`, `aria-labelledby`,
  `aria-live`/`role="alert"` prescribed for state changes).

**Unverified / at-risk (needs per-page pass in a later phase):**
- **Contrast** of the many literal greys on `#fefefe` — `#888`/`#999`/`#ccc` captions and
  `#ccc` remove-icons likely fail WCAG AA for small text in places.
- **Legacy modals** (`paymentMethodsModal`, `quote-modal`) lack focus trap / Escape → keyboard and
  screen-reader users can be stranded in exactly the financial flows that matter most.
- **Icon-only buttons** — sizing is guarded, but per-page `aria-label` presence isn't verified.
- Two dark-mode conventions risk a component being un-themed in one of them.

---

## 13. Responsiveness

- **Phone-shell model** is consistent: `≤430px` content column, `overflow-x: hidden` app-wide,
  `overscroll-behavior: contain` on scroll regions.
- **Breakpoints centralised** in `ui-polish.css`: ≥768px gives a framed device look (28px radius +
  shadow, `#eceff4` desk background); ≤767px goes edge-to-edge (radius 0, no shadow). `≤360px` and
  `≥430px` tweaks for the floating nav.
- **Safe areas** handled for nav, sheets, modals via `env(safe-area-inset-bottom)`.
- **Fluid type** appears only in a few legacy spots (ad banner `clamp()`); elsewhere type is fixed px.
- Not evidenced: landscape, foldable, or tablet-specific layouts beyond the desktop frame — the model
  is "one phone column, framed on big screens," which is a reasonable, consistent choice for an MVP.

---

## 14. Duplicate / fragmented component ledger

| # | Concept | Duplicate implementations | Canonical target |
|---|---|---|---|
| 1 | Modal engine | `.ui-modal` (css) · `modal.js` `#hh-modal` · `paymentMethodsModal.js` · `quote-modal.css` · settings `.modal-*` · personal-Info `.modal` | `.ui-sheet`/`openSheet()` + `.ui-modal` |
| 2 | Bottom sheet | `.ui-sheet` · settings `.bottom-sheet` · `em-modal-sheet` · `wd-sheet` · `am-sheet` · `#pmo-sheet` · `sched-modal` | `.ui-sheet` |
| 3 | Bottom nav | `.hh-fnav` (glass) · `.bottom-nav` (flat, in dead global.css + enforced in ui-polish) | `.hh-fnav` |
| 4 | Sidebar/drawer | `global.css` sidebar (300px) · `dashboard.css` sidebar (285px) | one shared drawer |
| 5 | Primary button | `.login-btn` `.btn-primary` `.book-now` `.enable-btn` `.chat-btn` `.view-more-btn` `.uc-topup` `.pc-book` … | `.ui-btn` (to build) |
| 6 | Text input | `.input-group` · `.input-signup` · `.search` · `.ui-modal-input` · per-page | `.ui-field` (to build) |
| 7 | Card | service · `sv-svc/pro` · `notif-card` · `bk-card` · promo · wallet/txn | one card system (converging on notif row) |
| 8 | Badge/chip | `.cat-btn` `.search-tag` `.badge` `.ui-tab-badge` `.hh-badge` `.hh-fnav-badge` `.notification-badge` `.sidebar-menu-badge` | `.ui-chip` / `.ui-badge` |
| 9 | Toast | `toast.js` styles living in dead `global.css` | move to `components/toast.css` |
| 10 | Font import | `@import DM Sans` repeated per page CSS | one `<link>` in shell |
| 11 | Reset | `* { box-sizing… }` re-declared per page | one reset in canonical layer |
| 12 | Dead motion | `@keyframes slide` defined twice in `global.css` | delete one |

---

## 15. Strengths

1. **A real, single-source token system** with spacing/radius/elevation/z/motion scales — the hard
   part is done and done well.
2. **The bottom-sheet + financial-auth stack is genuinely world-class** (focus/scroll/keyboard/swipe/
   morph/opacity-scar guard) and reused across money flows.
3. **Documentation & governance beyond most MVPs:** two contracts, a *measured* modal spec with a
   verification harness, and a CI token lint.
4. **Accessibility baked into the foundation** (tap floor, focus-visible, reduced motion, focus trap).
5. **Coherent, premium-leaning brand identity** with disciplined, sparing use of maroon and glass.
6. **Responsive shell model** centralised, with real safe-area handling.
7. **Back-nav, tabs, floating nav** already unified into single components.

## 16. Weaknesses

1. **Adoption gap is the headline:** 1,258 literal hex + 590 literal font-sizes + 188 literal radii
   in page CSS vs 717 token refs. Pages predate and bypass the system.
2. **No shared button / input / card primitives** — so pages hand-build them and reach for literals.
3. **Three modal engines + ≥6 sheet clones**, two of them missing focus-trap/Escape in financial flows.
4. **Two bottom-nav systems and two sidebars** coexist.
5. **No true typography scale** outside modals.
6. **Legacy alias vocabulary + two dark-mode conventions** keep two dialects alive.
7. **Dead-but-present code** (`global.css` ~1,200 lines, `variables.css`, duplicate keyframes) —
   inert, but confusing and a migration hazard.
8. **`ui-polish.css` is doing remediation work** (force-z-indexing legacy modals, retrofitting tap
   targets and card-radius fixes onto hand-listed classes) that masks fragmentation instead of
   removing it.

---

## 17. Maturity scorecard (detail)

```
Foundation (tokens, scales, governance)      ██████████████████░░  8.4
Shared component library (what exists)       ████████████████░░░░  8.0
Behaviour/interaction rigor (canonical path) █████████████████░░░  8.5
Motion system                                ███████████████░░░░░  7.5
Accessibility (shared layer)                 █████████████░░░░░░░  6.5
Responsiveness                               ██████████████░░░░░░  7.0
── the drag ──────────────────────────────────────────────────────────
Page-level adoption / consistency            ████████░░░░░░░░░░░░  4.0
Component consolidation (dedupe)             ██████████░░░░░░░░░░  5.0
Legacy/dead-code cleanliness                 █████████░░░░░░░░░░░  4.5
──────────────────────────────────────────────────────────────────────
OVERALL                                      ████████████▌░░░░░░░  6.4 / 10
```

---

## 18. Phase 2 roadmap (prioritized — for approval, not yet executed)

Ordered by **impact ÷ risk**. Foundational/low-risk first; money-adjacent last and gated.

**Tier A — foundation completion (low risk, high consistency payoff)**
1. ✅ **DONE (2026-07-17).** Missing primitives built as additive shared components consuming
   tokens: `.ui-btn` (`shared/css/components/button.css` — primary/secondary/tint/ghost/danger ×
   sm/md/lg/block/icon + `is-loading`/disabled) and `.ui-field`
   (`shared/css/components/field.css` — label/control/input/icon/trail/hint/error + filled/error).
   Both `@import`ed into `ui-polish.css`; zero existing pixels changed (new classes).
2. ✅ **DONE (2026-07-17).** Typography scale added to `ui-polish.css`
   (`--ui-font`, `--ui-text-display…micro`, `--ui-lh-*`, `--ui-fw-*`) plus functional ring tokens
   (`--ui-ring`, `--ui-ring-danger`). Registered in `DESIGN-SYSTEM-CONTRACT.md`.
3. **De-duplicate the shell chrome:** one DM Sans `<link>`, one reset, delete the duplicate
   `@keyframes slide`. *(Toast is already consolidated — `toast.js` self-injects an opaque v2;
   no `components/toast.css` needed. The `<link>`/reset dedupe is a per-page HTML sweep — folded
   into Tier B so each page is visually verified rather than swept blind.)*

**Tier B — consolidation (medium risk, needs visual verification per screen)**
4. **Migrate page CSS literals → tokens**, screen by screen, starting with the highest-count files
   (`dashboard`, `book-now`, `topup`, `settings`, `profile`, `booking-flow`). Verify each against a
   before/after screenshot.
5. **Unify cards** onto the converging notification-row + raised-card system.
6. **Retire the second bottom-nav and second sidebar**; standardise on `.hh-fnav` + one drawer.

**Tier C — modal consolidation (higher risk — touches financial + destructive flows; gate this)**
7. **Migrate `paymentMethodsModal`, `quote-modal`, settings `.modal-*`/`.bottom-sheet`,
   personal-Info `.modal`, and `modal.js` consumers onto `openSheet()` / `.ui-modal`**, then delete
   the `ui-polish.css` z-index remediation block. **Each migration verified for focus-trap, Escape,
   danger-colour, and — for money flows — the security-invariant behaviour before the old code is
   removed.** Do not batch these; they gate on the escrow/payment invariants recorded in project
   memory.

**Tier D — cleanup**
8. Delete dead files (`variables.css`, `global.css`) once confirmed zero-reference; remove legacy
   token aliases after references are migrated; converge on one dark-mode convention.

Each tier ends with the CI token lint tightened (lower the drift baseline) so gains can't regress.

---

## 19. What Phase 1 deliberately did **not** do

- No pages were redesigned, no components replaced, no code changed.
- Per-page HTML/JS was **grep-quantified and sampled**, not line-audited for all ~40 pages — the
  literal counts are exact; the per-screen *visual* verification belongs to Phase 2 Tier B.
- Runtime/contrast/screen-reader testing was not run (most screens are auth-gated); §12 flags the
  at-risk areas for a dedicated a11y pass.

---

*Foundation document for Phase 2 (Design System Refinement). Pairs with
`DESIGN-SYSTEM-CONTRACT.md` (token governance) and `MODAL_DESIGN_SYSTEM.md` (measured modal spec).*
