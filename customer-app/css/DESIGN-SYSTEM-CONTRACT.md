# Customer App — Design System Contract

**Status:** Token-layer consolidated (2026-06-24). One canonical source of truth.

## 1. Canonical source of truth
**`shared/css/ui-polish.css`** — the ONLY file that defines design-token *values*
for the customer app. It is loaded on 34/35 customer pages.

### Approved canonical tokens (`--ui-*`)
| Group | Tokens |
|---|---|
| Surfaces / ink | `--ui-bg` `--ui-surface` `--ui-text` `--ui-muted` `--ui-border` |
| Brand (maroon) | `--ui-primary` (#730201) `--ui-primary-soft` (#fde8e8) |
| Radius | `--ui-radius-sm` (10) `--ui-radius-md` (14) `--ui-radius-lg` (18) — *pill = 999px* |
| Elevation scale | `--ui-elev-0` (none) `--ui-elev-1` (cards) `--ui-elev-2` (floating) `--ui-elev-3` (modals/nav) + back-compat `--ui-shadow-sm` / `--ui-shadow-md`→elev-2 |
| Layout | `--ui-shell-max` `--ui-shell-max-wide` |

### Elevation rule (shadows)
Depth shadows MUST use `--ui-elev-0..3`. **Functional shadows are NOT elevation
and keep their own values:** focus/avatar/status RINGS (`0 0 0 Npx …`), brand
GLOWS (`rgba(115,2,1,…)` on primary buttons), and directional drawer/bar shadows
(horizontal/upward). Do not flatten those into elevation tokens — they encode
state/direction, not depth.

**Migration status (shadows):** `dashboard.css` done (4 elevation shadows →
tokens; 9 functional shadows preserved). Other 14 CSS files: pending (105 distinct
shadow strings app-wide → target 4 levels). This is the proof-of-pattern file.

### Legacy aliases (defined in canonical, resolve to `--ui-*`)
`--maroon` `--primary-red` `--secondary-bg` `--light-red` `--bg-white`
`--bg-page` `--text-dark` `--text-main` `--text-grey` `--text-sub` `--unread-bg`
→ kept so existing CSS renders identically. **Do not add new aliases.** Migrate
references to `--ui-*` over time, then delete the aliases.

## 2. Allowed usage rules
- Reference tokens via `var(--ui-…)` (or, transitionally, a legacy alias).
- Page-specific values that have **no canonical equivalent** may stay as
  documented local tokens (see §4) — but must be commented as local.

## 3. Forbidden patterns
- ❌ New `:root` token blocks in page CSS or inline `<style>`.
- ❌ Defining a token *value* anywhere except `ui-polish.css`.
- ❌ New competing namespaces (`--ds-*` is the **artisan** brand — never use it
  in the customer app).
- ❌ Hardcoded brand hex (`#730201`) — use `var(--ui-primary)`.

## 4. Migration status
| File | Status |
|---|---|
| `shared/css/ui-polish.css` | ✅ Canonical (values + aliases) |
| `shared/css/variables.css` | ✅ Deprecated (dead, 0 pages) |
| `shared/css/global.css` | ✅ `:root` blocks → canonical aliases (dead, 0 pages) |
| `customer-app/css/style.css` | ✅ `:root` blocks → canonical aliases (dead, 0 pages) |
| `customer-app/css/notification.css` | ✅ brand/ink → canonical; 3 local surface tints documented |
| `customer-app/css/booking-flow.css` | ✅ brand/surface → canonical; cooler greys + 16px radius + shadow kept local (preserve exact look) |

### Sanctioned local tokens (documented exceptions, not competing systems)
- `notification.css`: `--brand-mid #b10c0c`, `--border #f0f0f0`, `--icon-read-bg`, `--card-new-bg`
- `booking-flow.css`: `--bf-red-light`, `--bf-text #111827`, `--bf-sub #6B7280`, `--bf-border`, `--bf-radius 16px`, `--bf-shadow`

## 5. Remaining work (NOT done in this pass — staged)
Hardcoded values (~25 radii, hundreds of color/shadow literals) inside component
rules are **not yet** migrated to tokens. That is a separate, screen-by-screen
pass requiring visual verification (most screens are auth-gated). This contract
governs the **token layer**; component-level literal migration is phase 2.
