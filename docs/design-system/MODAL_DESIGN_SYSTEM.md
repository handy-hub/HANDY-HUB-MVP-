# Handy Hub — Modal Design System

**Status:** Canonical. **Authority:** This document is the single source of truth for every
modal, bottom sheet, dialog, tray, and overlay in Handy Hub. No modal may be built without
following it.

Every value below was **measured from the rendered browser** (Chromium, 430×932 viewport)
via `tests/modal-audit-harness.html`, not read from source. Re-run the audit after any change
to the shared modal CSS.

---

## 1. Canonical decision

Handy Hub has **two** approved modal surfaces and **one** lifecycle controller. Everything else
is legacy (see §9).

| Need | Use | Files |
|---|---|---|
| **Bottom sheet** (default for mobile: choices, forms, security, payment) | `.ui-sheet` + `openSheet()` | `shared/css/components/sheet.css`, `shared/js/components/sheet.js` |
| **Centred dialog** (short confirmations, destructive prompts) | `.ui-modal` | `shared/css/components/modal.css` |
| **Security / financial authorization** | `openSecurityPinSheet()` | `shared/js/components/securityPinSheet.js` |
| **Payment state (waiting/approved/failed/…)** | `openFinancialAuthorizationSheet()` | `shared/js/components/financialAuthorizationSheet.js` |

**Default to the bottom sheet.** Handy Hub is a mobile-first phone-shell app (`--ui-shell-max: 430px`);
sheets are the dominant idiom. Use a centred dialog only for a short, binary confirmation.

> `shared/css/components/modal.css` has **no JS controller**. If you need a dialog with focus
> management today, either use `.ui-modal` markup driven by `openSheet()`-style lifecycle code,
> or extend the shared controller. **Do not** revive `shared/js/components/modal.js` (§9).

---

## 2. Token layer (measured)

Tokens live in **`shared/css/ui-polish.css`** — the only token source. (`shared/css/variables.css`
is dead; it self-documents as deprecated and is loaded by zero pages.) **Never** define a
competing token set.

### Surface / colour
| Token | Value |
|---|---|
| `--ui-bg` | `#fefefe` (app canvas) |
| `--ui-surface` | `#ffffff` (modal + sheet surface) |
| `--ui-surface-2` | `#f5f5f5` (inset wells) |
| `--ui-overlay` | `rgba(0, 0, 0, 0.5)` (**the only approved scrim**) |
| `--ui-text` | `#111111` |
| `--ui-muted` | `#666666` (body copy) |
| `--ui-faint` | `#888888` (footnotes) |
| `--ui-border` | `rgba(0, 0, 0, 0.08)` |
| `--ui-primary` | `#730201` · `--ui-primary-rgb: 115, 2, 1` |
| `--ui-danger` | `#b22222` · `--ui-danger-rgb: 178, 34, 34` |

### Radius / size / spacing
| Token | Value | Use |
|---|---|---|
| `--ui-radius-sm` | `10px` | **buttons**, inputs, chips |
| `--ui-radius-md` | `14px` | cards, list rows |
| `--ui-radius-lg` | `18px` | **modal + sheet surfaces** |
| `--ui-radius-pill` | `999px` | handle, icon disc, pills |
| `--ui-sheet-radius` | `18px` (artisan overrides → `16px`) | sheet top corners |
| `--ui-btn-h` | `48px` | **every modal CTA** |
| `--ui-shell-max` | `430px` | sheet/overlay max width |
| `--ui-1…--ui-10` | `4/8/12/16/20/24/32/40px` | spacing scale |

### Elevation / z-index
| Token | Value |
|---|---|
| `--ui-elev-3` | `0 24px 64px rgba(0,0,0,.14), 0 2px 8px rgba(0,0,0,.06)` — dialog |
| sheet shadow | `0 -12px 32px -8px rgba(16,22,38,.18)` — sheet (upward cast) |
| `--ui-z-drawer` | `800` — sheet overlay |
| `--ui-z-modal` | `1000` — dialog overlay |
| `--ui-z-toast` | `2000` |

### Motion (added 2026-07-17 — previously hardcoded in five places)
| Token | Value | Use |
|---|---|---|
| `--ui-ease-emphasis` | `cubic-bezier(0.22, 1, 0.36, 1)` | **signature** enter/settle |
| `--ui-ease-exit` | `cubic-bezier(0.32, 0.72, 0, 1)` | swipe/fast dismiss |
| `--ui-ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | snap-back overshoot |
| `--ui-dur-instant` | `0.12s` | tap/press feedback |
| `--ui-dur-fast` | `0.15s` | hover, colour, opacity |
| `--ui-dur-backdrop` | `0.22s` | scrim fade |
| `--ui-dur-dialog` | `0.28s` | dialog enter |
| `--ui-dur-sheet` | `0.32s` | sheet slide |

### Modal type scale
| Token | Value |
|---|---|
| `--ui-modal-title-size` / `-weight` / `-lh` | `18px` / `800` / `1.25` |
| `--ui-modal-body-size` / `-lh` | `13.5px` / `1.55` |
| `--ui-modal-pad-block` / `-inline` | `28px` / `24px` |

**Font family is never set by a modal.** It inherits `'DM Sans'` from the page. Measured: every
modal surface resolves to `DM Sans`.

---

## 3. Bottom sheet — `.ui-sheet` (measured)

| Property | Value |
|---|---|
| Surface | `--ui-sheet-bg` → `#ffffff` (**always opaque** — see §8) |
| Width | `min(100%, 430px)` |
| Max height | `min(92dvh, 820px)` |
| Radius | `18px 18px 0 0` |
| Padding | `0 0 max(24px, env(safe-area-inset-bottom))` |
| Shadow | `0 -12px 32px -8px rgba(16,22,38,.18)` |
| Enter | `transform: translateY(100%) → 0`, `0.32s`, `--ui-ease-emphasis` |
| Backdrop | `::before`, `rgba(0,0,0,.5)`, `opacity 0 → 1`, `0.32s` (isolated — §8) |
| Z | overlay `800`; surface `z-index: 1` above its own `::before` (`z-index: 0`) |
| Scroll | `overflow-y: auto`, `overscroll-behavior: contain` |
| Handle | `36 × 4px`, `rgba(0,0,0,.12)`, `999px`, `margin: 12px auto 4px` |
| Sheet title | `15px / 800`, centred, `padding: 10px 20px 12px`, 1px bottom border |

---

## 4. Centred dialog — `.ui-modal` (measured)

| Property | Value |
|---|---|
| Surface | `#ffffff` |
| Width | `min(100%, 420px)` (overlay pads `16px`) |
| Max height | `min(86dvh, 760px)` |
| Radius | `18px` (all corners) |
| Padding | `28px 24px 24px` |
| Shadow | `--ui-elev-3` |
| Enter | `scale(.96) translateY(8px) → scale(1) translateY(0)`, `0.28s`, `--ui-ease-emphasis` |
| Backdrop | `rgba(0,0,0,.5)`, `opacity`, `0.22s ease` |
| Z | overlay `1000`, surface `1` |
| Title | `18px / 800 / lh 1.25`, `#111`, centred, `margin-bottom: 8px` |
| Body | `13.5px / 400 / lh 1.55`, `#666`, centred, `margin-bottom: 24px` |
| Icon disc | `52 × 52px`, `999px`, `rgba(115,2,1,.08)`, `margin: 0 auto 16px` |
| Actions | column, `gap: 10px` |
| Button | `h 48px`, `radius 10px`, `14.5px / 700`, `padding: 0 16px` |
| Primary | `#730201` on `#fff` |
| Danger | `#b22222` on `#fff` |
| Ghost | `rgba(0,0,0,.05)` on `#111` |
| Input | `radius 10px`, `padding: 13px 14px`, `margin-bottom: 14px`, focus → `--ui-primary` border |

**Sheet variant** — `.ui-modal-overlay--sheet`: bottom-aligned, `430px`, radius `18px 18px 0 0`,
padding `28px 24px 32px`, `translateY(24px) → 0`.

---

## 5. Modal types — when to use what

| Type | Surface | Notes |
|---|---|---|
| **Bottom sheet** | `.ui-sheet` + `openSheet()` | Default. Choices, forms, security, payment. Swipe + backdrop + Escape. |
| **Centred dialog** | `.ui-modal` | Short binary confirmation only. |
| **Confirmation tray** | `.ui-modal-overlay--sheet` | Icon + title + body + stacked actions. |
| **Destructive confirmation** | `.ui-modal` + `.ui-modal-btn--danger` + `.ui-modal-icon--danger` | Danger button is **`--ui-danger`**, not maroon (§9 records a live violation). Destructive action first, ghost cancel second. |
| **Security / financial** | `openSecurityPinSheet()` | §7. Never rebuild. |
| **Form modal** | `.ui-sheet` | Body scrolls; CTA uses `--ui-btn-h`. |
| **Full-height sheet** | `.ui-sheet` | Capped at `92dvh` — never `100dvh` (safe-area). |
| **Success / failure tray** | `.ui-sheet` + `.ui-modal-icon` | Icon disc tinted `--ui-success` / `--ui-danger`; single dismissing CTA. |

> **Receipts are not modals.** The top-up receipt is a full-screen surface
> (`topup.html` `.success-screen` / `ss-*`). Reuse that pattern for receipts.

---

## 6. Behaviour contract (non-negotiable)

`openSheet()` implements all of this. Reuse it — never reimplement.

- **Open:** mount → **forced reflow** (`void overlay.offsetHeight`) → `.open` → `focus()`, all in the
  **same task as the user's gesture**. The reflow commits the closed state so the enter transition
  still animates from it. **Never defer opening or focusing to `rAF`/`setTimeout`** — iOS raises the
  system keyboard only for `focus()` during a gesture, so a deferred focus silently produces no
  keyboard until the user taps the field. For the same reason, do not `await` network work between
  the tap and `openSheet()`, and `<link>` `sheet.css` on any page that opens sheets so the
  controller never waits on a stylesheet inside the gesture.
- **On-screen keyboard:** while open, the controller measures `window.visualViewport` and exposes
  the covered height as **`--ui-kb-inset`** on the overlay. `sheet.css` turns it into
  `padding-bottom` (lifting the sheet to sit on top of the keyboard, via `align-items: flex-end`)
  and shrinks `max-height` so a tall sheet scrolls internally instead of losing its top. It resets
  to `0px` when the keyboard closes and is untracked on teardown.
- **Dismiss:** backdrop tap, swipe-down, `Escape`. Any may be disabled per-sheet
  (`dismissible: { backdrop, swipe, escape }`) — e.g. a payment in flight.
- **Swipe:** `attachSwipeDismiss()` **only** (`shared/js/utils/sheetDismiss.js`). Dismiss at
  **38%** of sheet height or velocity **> 0.45 px/ms**; rubber-band ×0.12 upward; scrim fades with
  drag; only steals the gesture when the scrollable is at `scrollTop ≤ 0` or the drag starts on the
  handle / top 60px; exit `0.30s --ui-ease-exit`; snap-back `0.42s --ui-ease-spring`.
  **Touch-only** — desktop relies on Escape/backdrop.
- **Focus:** trap (Tab/Shift+Tab cycle), initial focus on the sheet, restore to the trigger on close.
- **Scroll lock:** `body.style.overflow = 'hidden'`, **reference-counted** for stacking.
- **Stacking:** only the topmost sheet handles Escape/Tab.
- **Duplicates:** `id` dedupes — reopening an open `id` returns the existing handle.
- **Cleanup:** DOM removed after the exit transition (`transitionend` + timeout fallback);
  listeners removed; `onClose(reason)` fires once with `'backdrop' | 'swipe' | 'escape'` or a custom reason.
- **Safe area:** `padding-bottom: max(24px, env(safe-area-inset-bottom))`.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` → `transition-duration: 0.01ms`.
- **A11y:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (visible title) or `aria-label`,
  `aria-describedby`, tap targets **≥ 44px**, `aria-live` for state changes, `role="alert"` for errors.

### Multi-step journeys — morph, never re-open
A flow with several steps (Security PIN → payment authorization → receipt) is **one sheet**.
Closing one sheet and opening another slides the shell down and back up, which reads as two
unrelated modals and breaks the sense of a single transaction.

Use the shell-morph API on the handle:

| API | Purpose |
|---|---|
| `replaceContent(el, { labelledBy, describedBy, initialFocus })` | Swap content in place; keeps position, motion, focus trap, scroll lock and swipe engine. Re-points the accessible name/description and cross-fades via `.ui-sheet-swap-in`. |
| `setDismissible({ backdrop, swipe, escape })` | Lock/unlock at runtime — **lock while money is in flight**. Swipe is gated by `canDismiss` in the one gesture engine, never detached. |
| `setOnClose(fn)` | Hand teardown to the step that now owns the shell. |

The outgoing step must **release** first — cancel its timers, drop its listeners, wipe its secrets,
and stop claiming `onDismiss` (see `securityPinSheet`'s `controls.release()`); otherwise a stale
timer from a finished step can close a sheet that now owns a live payment.

### State rules
| State | Rule |
|---|---|
| Loading | Disable the CTA + inputs; spinner **inside** the CTA; never swap the frame. |
| Error | Message in a persistent slot (`min-height` reserved so nothing reflows); `role="alert"`; `--ui-danger`. |
| Success | Same frame; content swap only. |
| Disabled | `opacity: .45; cursor: not-allowed`. |

---

## 7. Security PIN sheet — `openSecurityPinSheet()`

The **one** reusable checkpoint for financial authorization (top-ups, withdrawals, payout and
payment-method changes, high-value actions). It is purpose-agnostic: callers pass copy + handlers.

```js
import { openSecurityPinSheet } from '../shared/js/components/securityPinSheet.js';

const pin = await openSecurityPinSheet({
  mode: 'enter',                       // 'enter' | 'create' (create → confirm, internally)
  title: 'Enter your PIN',
  message: 'Enter your 4-digit Handy Hub Security PIN to confirm this top-up.',
  context: 'Top-up · GHS 50.00',       // optional chip
  confirmLabel: 'Confirm Top Up',
  onConfirm: (pin, controls) => { controls.setBusy(true); /* server call */ },
  onCreate:  (pin, controls) => { /* create mode only */ },
  onForgot:  (controls) => { /* renders the outlined secondary action */ },
  onDismiss: (reason) => { /* user backed out — no cost */ },
});
```

`controls`: `setBusy(bool)` · `showError(msg)` (shake + clear) · `clear()` · `close(reason)`.

**Structure** (reference-image hierarchy, system typography): handle → title → supporting text →
context chip → 4 indicators → primary CTA → outlined secondary → security footer.

**Entry uses the SYSTEM keyboard** (product decision, 2026-07-17 — supersedes the original
custom-keypad rule). A transparent `<input>` is stretched over the indicators and focused as the
sheet lands, so the OS keypad opens ready to type and fills the space the custom pad occupied.

> **Accepted trade-off, recorded deliberately.** The PIN necessarily exists in an input value, so
> it *is* briefly in the DOM — reachable by injected script, autofill, and password managers. This
> was a knowing product call, not an oversight. It is mitigated by: `type="password"` +
> `-webkit-text-security` (never rendered as text), `inputmode="numeric"`, `autocomplete="off"`,
> `spellcheck="false"`, `maxlength`, a digits-only sanitiser, and `wipeSecrets()` scrubbing the
> value on **every** exit (submit, mismatch, dismissal, background, timeout). `digits` stays the
> source of truth; the input is a mirror. **A custom keypad remains the stronger option if this is
> ever revisited.**

**Rules that must never regress:**
- Digits are never written to storage, an attribute, a URL, or a log line; never rendered as text.
- The input is **masked, invisible, and scrubbed on every exit** — the dots are the only UI.
- Use `font-size: 16px` on the entry — anything smaller makes iOS zoom the page on focus.
- Create mode: entering the 4th digit **auto-advances**; there is no Continue button. The confirm
  step offers **Back** (wipes the first entry).
- iOS raises the keyboard only for focus inside a user gesture; the sheet opens async, so autofocus
  is best-effort there. The indicators are tappable to re-raise it — never rely on autofocus alone.
- Secrets wiped on: close, mismatch, `visibilitychange → hidden`, `pagehide`, and a **120s idle timeout**.
- Verification is **server-side only**, and never via a standalone verify endpoint (brute-force oracle) —
  it happens inside a trusted operation. See `functions/securityPin.js`.

---

## 8. Financial authorization state sheet

`openFinancialAuthorizationSheet()` is the continuation surface after the Security PIN checkpoint.
It composes the canonical `openSheet()` controller and must never implement its own overlay, motion,
focus trap, scroll lock, swipe engine, safe-area padding, or elevation.

The same mounted frame transitions through `waiting`, `approved`, `failed`, `timed_out`, `cancelled`,
and `unreachable` using `controls.setState(nextState)`. Financial integrations must update that
instance rather than opening a second state-specific modal. Waiting copy must reflect authoritative
provider state: never say a request was sent until the trusted charge endpoint confirms initiation.

```js
const authorization = await openFinancialAuthorizationSheet({
  state: 'waiting', amount: 'GHS 50.00', provider: 'MTN MoMo', phone: '······3455'
});
authorization.setState('approved');
```

---

## 9. Opacity: the rule and the scar

**A modal surface must never be transparent.** Page content sits directly behind it.

The scrim and the surface must be **separate compositing layers**. The overlay carries the scrim on
a `::before` (or a dedicated `.modal-backdrop` element) at `z-index: 0`; the surface sits at
`z-index: 1` with `isolation: isolate`. **Never** animate opacity on a shared ancestor of both — the
surface inherits the fade and the page bleeds through.

> **Real incident (2026-07-17).** `sheet.css`'s header comment contained **nested `/* */` markers**.
> CSS comments do not nest: the comment terminated early, and the parser's error recovery discarded
> the **entire `:root` token block**. `--ui-sheet-bg` became undefined → every `.ui-sheet` in the app
> rendered **fully transparent**, with radius `0` and dead motion tokens.
>
> **Rules:** never nest comment markers in CSS. Always give a surface a layered fallback —
> `background: var(--ui-sheet-bg, var(--ui-surface, #ffffff))` — so a missing token degrades to
> solid white, never transparent. Assert `backgroundColor === 'rgb(255, 255, 255)'` in tests.

---

## 9. Non-canonical inventory (do not copy; migrate on touch)

Measured divergences. **None of these are approved.**

| Implementation | Divergence (measured) |
|---|---|
| `shared/js/components/modal.js` | **Legacy engine.** Injects its own `#hh-modal-*` styles — `modal.css` states it *replaces* them, but the migration never happened. Motion `0.18s`/`0.2s ease` (not the signature curve). Singleton — cannot express sequential flows. **Do not use; migrate to `openSheet()`.** |
| `customer-app/js/pages/paymentMethodsModal.js` | radius **28px** (≠18), duration **0.38s** (≠0.32), scrim **0.45** (≠0.5), maxW **480px** (≠430), z **1900/1910**, no focus trap, no Escape, native `confirm()`. |
| `customer-app/css/quote-modal.css` | scrim **0.55** (≠0.5), easing **`cubic-bezier(.32,.72,0,1)`** on *enter* (that's the exit curve), `var(--surface)` / `var(--surface-2)` — **tokens that do not exist** (only fallbacks save it), hardcoded `font-family`, `display:none` toggling (no transition). |
| `customer-app/css/settings.css` `.modal-*` | Token-aligned alias of `.ui-modal--sheet`; **but** `.modal-btn-danger` uses `--ui-primary` (maroon), not `--ui-danger`. Title lacks `line-height` → `26.1px` vs canonical `22.5px`. |
| `customer-app/css/settings.css` `.bottom-sheet` | Value-identical clone of `.ui-sheet` (`translateX(-50%)` centring). No shadow. Redundant. |
| `customer-app/css/personal-Info.css` `.modal` | `position: absolute` (≠ fixed), duration `0.3s` (≠0.32), padding `24px 20px`. |
| `shared/css/ui-polish.css` §"modal normalization" (L457–525) | **Remediation layer**: force-lifts legacy modals to `z-index: 1900/1910 !important`, overriding the `--ui-z-*` scale. Canonical `.ui-sheet` (800) therefore renders **below** any legacy modal. Delete this block only when every consumer is migrated. |

**Migration policy:** don't rip these out blindly. When you touch a page owning one, migrate it to
`openSheet()` + tokens and verify behaviour before retiring the old code.

---

## 10. How to Build a New Handy Hub Modal

**Process**
1. **Check §5.** Pick the approved type. Don't invent one.
2. **Use `openSheet()`** (or `openSecurityPinSheet()` for financial auth). Never write open/close logic.
3. **Style only your interior**, using tokens. The frame, motion, scrim, focus, scroll lock, swipe,
   and cleanup are already correct.
4. **Verify** against §11 and re-run `tests/modal-audit-harness.html`.

**Template**
```js
import { openSheet } from '../shared/js/components/sheet.js';

const body = document.createElement('div');
body.innerHTML = `
  <h2 class="ui-modal-title" id="x-title">Title</h2>
  <p  class="ui-modal-body"  id="x-desc">Supporting copy.</p>
  <div class="ui-modal-actions">
    <button class="ui-modal-btn ui-modal-btn--primary">Confirm</button>
    <button class="ui-modal-btn ui-modal-btn--ghost">Cancel</button>
  </div>`;

const sheet = await openSheet({
  id: 'my-feature',            // dedupes
  content: body,
  labelledBy: 'x-title',
  describedBy: 'x-desc',
  onClose: (reason) => { /* 'backdrop' | 'swipe' | 'escape' | custom */ },
});
// sheet.close('done');
```
Interior styling: `var(--ui-modal-title-size)`, `var(--ui-modal-body-size)`, `var(--ui-btn-h)`,
`var(--ui-radius-sm)`, `var(--ui-dur-fast)`, `var(--ui-ease-emphasis)` …

**Never**
- create a second modal engine, overlay system, or gesture handler;
- hardcode modal typography, radii, scrim colour, or animation timings;
- assign an arbitrary `z-index` (use `--ui-z-*`; never add to the 1900 block);
- duplicate focus-trap or scroll-lock logic;
- ship a **transparent** modal surface (§8);
- omit safe-area padding;
- leave a secret in an input value after the sheet closes (§7);
- bypass the a11y contract (§6);
- build a page-local `.modal-overlay` — three already conflict.

---

## 11. Verification checklist

Run `tests/modal-audit-harness.html` + `tests/pin-sheet-harness.html` and confirm:

- [ ] Font family resolves to `DM Sans` (inherited, not set)
- [ ] Surface `rgb(255, 255, 255)` — **never** transparent, in light *and* dark
- [ ] Radius `18px`; buttons `10px`
- [ ] Title `18px / 800 / 1.25`; body `13.5px / 1.55 / #666`
- [ ] CTA height `48px`
- [ ] Scrim `rgba(0, 0, 0, 0.5)` on its own layer
- [ ] Shadow: dialog `--ui-elev-3`; sheet `0 -12px 32px -8px rgba(16,22,38,.18)`
- [ ] Enter: sheet `0.32s` / dialog `0.28s`, `cubic-bezier(0.22, 1, 0.36, 1)`
- [ ] Z from `--ui-z-*` (drawer 800 / modal 1000) — no arbitrary values
- [ ] Safe-area bottom padding present
- [ ] Escape, backdrop, swipe dismiss; focus trapped and restored; scroll locked then released
- [ ] Reduced motion honoured
- [ ] Reopening the same `id` yields one instance
- [ ] Renders at 320px, 430px, and desktop widths without breaking

---

*Maintained by the Handy Hub design-system owners. Values measured 2026-07-17 (Chromium 430×932).
If you change a shared modal value, update this document in the same commit.*
