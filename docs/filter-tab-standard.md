# Filter / Tab / Segmented-Control Standard

**Canonical implementation:** `shared/css/components/tabs.css` (`.ui-tabs` / `.ui-tab`, pill variant).

This is the ONE filter-tab, segmented-control, and category-selector
component for the entire platform (customer-app and artisan-app). It was
proven and standardized across `notification.html`, `booking.html`, and
`saved.html` — those three pages are the reference usage.

## Why this exists

Before convergence, this exact interaction (a row of tappable filter pills)
was independently reinvented as `.bk-tab`, `.jobs-tab`, `.notif-tab`,
`.tab-btn`, `.chip`, `.sv-tab`, each with its own class names, its own
spacing, its own active-state color logic, and its own copy of the same
touch-target/accessibility concerns. Every one of those was a rebuild of a
solved problem, and each rebuild silently drifted from the others. This is
not a hypothetical risk — it is exactly what happened, more than once, in
this codebase.

## The rule

**If a page needs a filter tab, segmented control, or category selector, it
uses `.ui-tabs` / `.ui-tab`. It does not define a new class.**

```html
<div class="ui-tabs" role="tablist">
  <button class="ui-tab active" role="tab" aria-selected="true">All</button>
  <button class="ui-tab" role="tab" aria-selected="false">Bookings</button>
</div>
```

Artisan-app pages add the `.ui-tabs--artisan` modifier so the active state
renders in the artisan brand color instead of the customer maroon:

```html
<div class="ui-tabs ui-tabs--artisan" role="tablist">…</div>
```

A page **may** add its own class alongside `.ui-tabs` purely for layout
concerns (e.g. `saved.html`'s `.sv-tabs` for a bottom margin, `booking.css`'s
`.ui-tabs` sticky-background rule) — but that page-local class must not
redefine color, radius, border, padding, or active-state styling. If you find
yourself writing `.your-page-tabs .ui-tab.active { ... }`, stop — that is the
exact pattern that produced `saved.css`'s soft-pink override this standard
replaced.

## Enforcement

`scripts/check-filter-tabs.cjs` runs on `npm test` and before every
`npm run deploy*` command. It scans every `.html`/`.css` file for:

1. A new class matching `-tab`, `-tabs`, `-chip`, or `-filter` that pairs an
   `.active`/`[aria-selected="true"]` rule with `border-bottom` or a solid
   `background` — the fingerprint of a hand-rolled tab component.
2. Any page with `role="tablist"` markup that doesn't link
   `shared/css/components/tabs.css`.

Run it directly with:

```
npm run lint:filters
```

It fails the build with `file:line` findings, not just a warning — a filter
tab component is easy enough to get right the first time that "convert it
later" is not an acceptable answer; that's exactly how the last six
implementations accumulated.

## Known outstanding debt (as of this writing)

The linter currently also flags pre-existing implementations that were
**not** part of the notification/booking/saved convergence and have not yet
been migrated:

- `customer-app/book-emergency.html` — `.em-chips` / `.em-chip`
- `customer-app/css/book-now.css` — `.bn2-svc-chip`
- `customer-app/css/booking-flow.css` — `.bk-cat-tab`, `.bk-date-chip`, `.bk-time-chip`
- `artisan-app/reviews.html` — `.rv-tabs` / `.rv-tab`

These are real, tracked debt, not false positives — they should be migrated
onto `.ui-tabs` the same way notification/booking/saved were. Until they are,
`npm run deploy*` will fail on this check; do not silence it by deleting the
finding or excluding the file — migrate the markup instead.
