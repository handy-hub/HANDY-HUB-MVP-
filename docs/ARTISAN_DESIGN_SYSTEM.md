# Fidus X Artisan — design system

Phase 1 foundation (2026-11-06). One system for every artisan screen built from
here on. The live reference is `design/artisan/index.html` (not deployed): open it
from a server at the repo root (`python -m http.server 8791`, then
`/design/artisan/`).

| File | What it is |
|---|---|
| `artisan-app/css/tokens.css` | Every raw value: colour, type, space, radius, size, elevation, focus, motion, layers. The only file allowed to hold one. |
| `artisan-app/css/app.css` | The components. Tokens only. |
| `artisan-app/js/fx/icons.js` | The icon set (24px grid, 1.75 stroke, `currentColor`). |
| `artisan-app/js/fx/sheet.js` | Bottom-sheet behaviour: modal, focus trap, Escape, focus return. |
| `artisan-app/js/fx/toast.js` | Toasts in a live region. |
| `artisan-app/js/fx/controls.js` | Segmented control, countdown, the four-tab bar. |
| `scripts/check-fx-design-system.cjs` | The gate (`npm run lint:fx`, part of `npm run lint`). |
| `tests/fx-design-system.test.cjs` | Tokens, contrast, the gate itself, pure behaviour. |
| `tests/e2e/fx_design_system.py` | The rendered system at 360 / 390 / 768 / 1280 px. |

## Rules

1. **Tokens only.** Outside `tokens.css`, no raw colour, radius, shadow, font
   value, z-index, duration or spacing length. The gate fails the build. A
   genuine exception carries `/* fx-allow: reason */` on its line and is listed
   every time the gate runs.
2. **Orange is a fill, never text on white.** The one primary action, live state,
   the selected-tab marker and the countdown bar. Labels on it are near-black
   (`--fx-on-accent`, 6.6:1). Orange text and links use `--fx-accent-text`
   (#C2410C, 5.2:1). Small indicators (badges, unread dots) use
   `--fx-indicator` (the deep orange), because #F97316 is 2.8:1 on white.
3. **State lives in ARIA.** `aria-pressed`, `aria-current`, `aria-busy`,
   `aria-invalid`, `aria-disabled`, `disabled`, `data-urgency`. No `.is-*` state
   classes.
4. **Focus is an ink outline**, 2px, offset 2px (inset on full-bleed rows and
   tabs). On ink surfaces a component re-points `--fx-focus-color`. Never remove
   it without replacing it (inputs thicken their edge to 2px of ink instead).
5. **Sizes grow with text.** Type is in rem; controls use `min-height`, never a
   fixed height; money never wraps inside itself but moves whole to its own line.
6. **Hover only where hover exists** (`@media (hover: hover)`).
7. **Scope.** Every selector in the system targets an `.fx-` class, so nothing
   leaks into a screen that has not migrated. Specificity is capped at three
   class-level parts (`:where()` adds none).
8. **Customer maroon stays out.** Nothing in `customer-app/` references `--fx-*`,
   and the artisan tokens hold no customer colour.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Neutrals | `--fx-ink` #111316 · `--fx-ink-2` #3B4048 · `--fx-ink-3` #62676F · `--fx-ink-4` #9EA3AA · `--fx-paper` #FFFFFF · `--fx-well` #F3F3F2 · `--fx-well-2` #E8E8E6 · `--fx-line` #E6E7E9 · `--fx-line-2` #CFD2D6 · `--fx-edge` #80858D | ink 18.6:1, ink-2 10.4:1, ink-3 5.7:1 on paper; ink-4 disabled only; edge 3.7:1 (control boundaries) |
| Accent | `--fx-accent` #F97316 · `--fx-accent-press` #E8620A · `--fx-on-accent` #111316 · `--fx-accent-text` #C2410C · `--fx-indicator` #C2410C · `--fx-accent-glow` | |
| Status | `--fx-ok` / `-wash`, `--fx-info` / `-wash`, `--fx-warn` / `-wash`, `--fx-bad` / `-wash`, `--fx-on-bad`, `--fx-scrim`, `--fx-on-ink`, `--fx-on-ink-2` | every text/wash pair ≥ 4.5:1 |
| Type | `--fx-font` (DM Sans) · weights `--fx-w-read` 400, `--fx-w-label` 550, `--fx-w-strong` 650 · sizes display 34/40, title 24/30, heading 18/24, body 16/24, label 14/20, caption 12/16 · composites `--fx-t-display` … `--fx-t-caption`, `--fx-t-body-strong`, `--fx-t-meta`, `--fx-t-button`, `--fx-t-button-s` · tracking | six sizes, three weights |
| Space | `--fx-space-0`, `-px`, `-h` (2), `-1` 4 … `-12` 48 · `--fx-gutter` 20 (16 under 375px) | 4-point grid |
| Radius | `--fx-r-chip` 6 · `--fx-r-control` 8 · `--fx-r-sheet` 16 · `--fx-r-round` 999 | four values |
| Dimensions | `--fx-h-l` 56 · `--fx-h-m` 48 · `--fx-h-s` 36 · `--fx-hit` 44 · `--fx-bar` 56 · `--fx-tab` 64 · `--fx-row` 56 · chip, icon, avatar, dot, badge, rail, marker, spinner, `--fx-shell-max` 560, `--fx-measure` | |
| Elevation | `--fx-e-none`, `--fx-e-sheet`, `--fx-e-pop`, `--fx-e-bar` · rings `--fx-ring-selected`, `-badge`, `-input`, `-invalid`, `-off` | shadows only for layers |
| Focus | `--fx-focus-color` (ink), `--fx-focus-width` 2, `--fx-focus-offset` 2, `--fx-focus-offset-inset` −3 | |
| Motion | `--fx-ease`, `--fx-ease-io`, `--fx-d-press` 90, `--fx-d-state` 180, `--fx-d-sheet` 320, `--fx-d-spin`, `--fx-d-pulse`, `--fx-d-tick`, `--fx-d-none` | all collapse under reduced motion |
| Layers | `--fx-z-base`, `--fx-z-bar` 10, `--fx-z-overlay` 30, `--fx-z-toast` 40 | |
| Responsive | compact < 375px (gutter 16) · regular · wide ≥ 600px (one centred 560px column) | |

## Components

| Component | Classes | Variants | States |
|---|---|---|---|
| Shell | `.fx-app` (body), `.fx-shell`, `.fx-main`, `.fx-bottom`, `.fx-skip` | — | sticky bars; document scroll |
| App bar | `.fx-appbar` `__titles __title __sub __actions` | `--root` (tab home, large title), `--push` (back, hairline) | safe-area top |
| Icon button | `.fx-iconbtn`, `__badge` | — | hover, active, focus, disabled |
| Availability | `.fx-avail` + `.fx-dot` / `.fx-spin` | — | `aria-pressed` on/off, `aria-busy` saving, `aria-disabled` locked |
| Button | `.fx-btn` | `--primary --secondary --tertiary --danger --danger-solid` · `--l --s --block` · `.fx-btnrow` | hover, active, focus, `disabled`/`aria-disabled`, `aria-busy` + `.fx-spin` |
| Chip | `.fx-chip`, `__dot` | `--ok --info --warn --bad --accent` | — |
| Dot | `.fx-dot` | `--live --off --warn --bad` | pulse stops under reduced motion |
| Section | `.fx-sect` `__head __title __body` | — | — |
| List row | `.fx-list`, `.fx-row` `__lead __main __title __meta __trail __value` | `div` / `a` / `button` | hover, active, focus (inset), `aria-disabled` |
| Ledger | `.fx-ledger` `__row __k __v __note` | `__row--sub --pending --total` | figures tabular, never broken |
| Journey rail | `.fx-rail` `__track __seg __cap __now` | `__seg--done --current` | the caption says it in words |
| Countdown | `.fx-countdown` `__bar __fill __text __value __label` | `data-urgency` normal / soon / now / done | `--fx-countdown` 0…1 from `bindCountdown` |
| Notice | `.fx-notice` `__icon __body __title __actions` | `--ok --info --warn --bad` | role per use: note / status / alert |
| Field | `.fx-field` `__label __hint __error`, `.fx-input`, `.fx-select` `__chev`, `.fx-money` `__cur` | input, textarea, select, money | focus (2px ink), `aria-invalid`, `disabled`, `readonly` |
| Segmented | `.fx-seg[role=group]`, `.fx-seg__btn` | — | `aria-pressed`, focus on any segment, `disabled` |
| Avatar | `.fx-avatar` | `--s --l`, initials, image, icon | — |
| Sheet | `.fx-overlay`, `.fx-scrim`, `.fx-sheet` `__head __title __body __actions` | `--tall` | modal via `openSheet()`; `data-state="closing"` |
| Toast | `.fx-toasts`, `.fx-toast` `__icon __text __action` | tone via `showToast()` | polite / alert; pauses on hover and focus |
| Dock | `.fx-dock` `__note __actions` | — | safe-area bottom when last |
| Tab bar | `.fx-tabbar`, `.fx-tab`, `__badge` | four tabs (`renderTabbar`) | `aria-current="page"` |
| Loading | `.fx-skel` | `--title --row` | on a genuine cache miss only |
| Utilities | `.fx-display … .fx-caption`, `.fx-meta`, `.fx-lead`, `.fx-num`, `.fx-strong`, `.fx-ink-2/-3`, `.fx-link`, `.fx-sr`, `.fx-pad`, `.fx-stack(--2/--4/--6)` | | |

## Migrating a screen (Phase 2 onwards)

1. Replace the page's DM Sans link with the variable-axis request
   `family=DM+Sans:opsz,wght@9..40,400..800` (fixed weights would snap 550 and
   650 to the nearest file).
2. Link `css/tokens.css` then `css/app.css`; set `<body class="fx-app">`. From
   that moment the gate checks the page's `<style>` blocks and forbids `style=""`.
3. Screen-specific CSS goes in `artisan-app/css/fx/<screen>.css`, which the gate
   scans like `app.css`.
4. Drop the page's `design-system.css` / `dashboard.css` / `ui-polish.css` links
   only once nothing on the page uses `.ds-*` or the legacy names. Until every
   screen has moved, `design-system.css` stays for the others, unchanged.
5. Re-express each page-source pin in the existing tests against the new markup
   (docs/ARTISAN_PHASE1_BOUNDARIES.md §4) — never delete one without a
   replacement.
6. Keep the shared contracts (§3 of the boundaries doc): the screen draws; the
   domain modules decide.

## Open

- **Dark mode** (Workbench decision 04): these tokens are light only. Existing
  screens keep their dark mode through `design-system.css`; a migrated screen is
  light until a dark mapping is designed.
- **Wordmark and app icon** (decision 05): no Fidus X SVG exists yet.
- **Account tab** points at `settings.html` until the Account screen is designed.
