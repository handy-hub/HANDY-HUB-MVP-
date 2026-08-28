/**
 * securityPinSheet.js — the HandyHub Security PIN authorization sheet.
 *
 * ONE reusable checkpoint for every financially sensitive action: wallet
 * top-ups, artisan withdrawals, payout-account changes, and future high-value
 * operations. Flows differ only in copy and handlers — the component knows
 * nothing about any specific payment purpose.
 *
 * Two modes, decided by the CALLER from real backend state (the component
 * never guesses):
 *   mode: 'enter'   (default) — "Enter your PIN" → onConfirm(pin, controls)
 *   mode: 'create'  — smart two-step flow inside the same sheet:
 *                     "Create your PIN" → Continue → "Confirm your PIN" →
 *                     match → onCreate(pin, controls); mismatch → safe error,
 *                     confirmation entry cleared, retry allowed.
 *
 * Built ON the canonical stack, never beside it:
 *   • sheet.js / sheet.css   → lifecycle, motion, a11y, swipe, backdrop
 *   • ui-polish tokens       → color, radius, type
 * Only the PIN-specific interior (indicators, keypad) is defined here.
 *
 * Entry uses the SYSTEM keyboard (product decision, 2026-07-17): a transparent
 * <input> is stretched over the indicators and focused as the sheet lands, so the
 * OS keypad opens ready to type and fills the space a custom pad used to take.
 * Trade-off accepted knowingly: the PIN necessarily exists in an input value, so
 * it IS briefly in the DOM. It is masked (type=password + -webkit-text-security),
 * never rendered as text, autofill/spellcheck are off, and the value is scrubbed
 * on every exit path (submit, mismatch, dismissal, background, timeout).
 *
 * Security properties:
 *   • `digits` remains the source of truth; the input is a mirror that is
 *     sanitised to digits, capped at pinLength, and wiped by wipeSecrets().
 *   • Digits are never written to storage, an attribute, a URL, or a log line.
 *   • The create-flow's first entry (firstPin) is held in memory for the
 *     shortest possible time and wiped on: success, mismatch retry cycles
 *     ending, dismissal, timeout, page hide, and app backgrounding.
 *   • The joined PIN string exists only for the synchronous handler call.
 *   • Idle timeout (default 2 min) closes the sheet and wipes all secrets.
 *   • This is the HandyHub Security PIN — an account-level credential
 *     verified SERVER-side. It is not a Mobile Money PIN, not a Paystack OTP,
 *     not the Firebase password, and never a client-side gate on its own.
 */

import { openSheet } from './sheet.js';

const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function injectStyles() {
    if (document.getElementById('hh-pin-sheet-styles')) return;
    const style = document.createElement('style');
    style.id = 'hh-pin-sheet-styles';
    style.textContent = `
.hh-pin {
  position: relative;
  padding: var(--ui-2, 8px) var(--ui-modal-pad-inline, 24px) calc(var(--ui-2, 8px) + env(safe-area-inset-bottom, 0px));
  text-align: center;
}
.hh-pin-back {
  position: absolute; left: var(--ui-2, 8px); top: 0;
  display: inline-flex; align-items: center; gap: 3px;
  min-height: 44px; padding: var(--ui-2, 8px) var(--ui-3, 12px);
  background: none; border: none; border-radius: var(--ui-radius-sm, 10px);
  font-family: inherit; font-size: var(--ui-modal-body-size, 13.5px); font-weight: 700;
  color: var(--ui-primary, #730201); cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.hh-pin-back[hidden] { display: none; }
.hh-pin-back:active { opacity: .7; }
.hh-pin-back:focus-visible { outline: 3px solid var(--ui-primary, #730201); outline-offset: 2px; }
.hh-pin-head {
  transition: opacity var(--ui-dur-fast, 0.15s) var(--ui-ease-emphasis, cubic-bezier(0.22, 1, 0.36, 1)),
              transform var(--ui-dur-fast, 0.15s) var(--ui-ease-emphasis, cubic-bezier(0.22, 1, 0.36, 1));
}
.hh-pin-head.morph { opacity: 0; transform: translateY(5px); }
/* Title + body follow the canonical modal type scale — see
   docs/design-system/MODAL_DESIGN_SYSTEM.md §2. Never restyle per-flow. */
.hh-pin-title {
  font-size: var(--ui-modal-title-size, 18px);
  font-weight: var(--ui-modal-title-weight, 800);
  line-height: var(--ui-modal-title-lh, 1.25);
  color: var(--ui-text, #111);
  margin: var(--ui-3, 12px) 0 var(--ui-2, 8px);
}
.hh-pin-msg {
  font-size: var(--ui-modal-body-size, 13.5px);
  line-height: var(--ui-modal-body-lh, 1.55);
  color: var(--ui-muted, #666);
  max-width: 320px; margin: 0 auto var(--ui-3, 12px);
}
.hh-pin-context {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 700; color: var(--ui-primary, #730201);
  background: rgba(var(--ui-primary-rgb, 115, 2, 1), 0.06);
  border-radius: var(--ui-radius-pill, 999px);
  padding: 6px var(--ui-3, 12px); margin-bottom: var(--ui-3, 12px);
}
/* The system keyboard drives entry. A transparent input is stretched over the
   indicators so it is the focus/tap target: the OS keypad opens with the sheet
   and fills the space the custom pad used to occupy, while the digits still
   render only as dots — never as readable text. */
.hh-pin-entry { position: relative; margin: var(--ui-4, 16px) 0 var(--ui-2, 8px); }
.hh-pin-input {
  position: absolute; inset: -14px 0;
  width: 100%; height: calc(100% + 28px);
  opacity: 0; border: 0; padding: 0; margin: 0; background: none;
  font-size: 16px;            /* >=16px stops iOS zooming the page on focus */
  color: transparent; caret-color: transparent;
  -webkit-text-security: disc;
  cursor: pointer;
}
.hh-pin-input:focus { outline: none; }
.hh-pin-entry:focus-within .hh-pin-dot {
  border-color: rgba(var(--ui-primary-rgb, 115, 2, 1), 0.55);
}
.hh-pin-dots { display: flex; justify-content: center; gap: var(--ui-6, 24px); margin: var(--ui-2, 8px) 0 2px; }
/* PIN-specific: no system primitive exists for secure indicators. Sizing,
   colour and motion still come from the system. */
.hh-pin-dot {
  width: 22px; height: 22px; border-radius: var(--ui-radius-pill, 999px);
  border: 1.5px solid rgba(0, 0, 0, 0.22); background: transparent;
  transition: border-color var(--ui-dur-fast, 0.15s) ease,
              background-color var(--ui-dur-fast, 0.15s) ease;
}
.hh-pin-dot.filled {
  background: var(--ui-primary, #730201);
  border-color: var(--ui-primary, #730201);
  animation: hh-pin-pop var(--ui-dur-backdrop, 0.22s) var(--ui-ease-emphasis, cubic-bezier(0.22, 1, 0.36, 1));
}
@keyframes hh-pin-pop { 0% { transform: scale(.6); } 55% { transform: scale(1.18); } 100% { transform: scale(1); } }
.hh-pin-dots.error .hh-pin-dot { border-color: var(--ui-danger, #b22222); background: transparent; }
.hh-pin-dots.error { animation: hh-pin-shake .4s; }
@keyframes hh-pin-shake {
  20%, 60% { transform: translateX(-7px); }
  40%, 80% { transform: translateX(7px); }
}
.hh-pin-error {
  min-height: 18px; font-size: 12.5px; font-weight: 600;
  color: var(--ui-danger, #b22222); margin: 8px 0 0;
}
/* Buttons ARE system primitives: identical geometry/type to .ui-modal-btn
   (48px · radius-sm · 14.5px/700) — see MODAL_DESIGN_SYSTEM.md §4. */
.hh-pin-confirm {
  width: 100%; height: var(--ui-btn-h, 48px); margin: var(--ui-5, 20px) 0 var(--ui-2, 8px);
  border: none; border-radius: var(--ui-radius-sm, 10px);
  background: var(--ui-primary, #730201); color: #fff;
  font-family: inherit; font-size: 14.5px; font-weight: 700;
  cursor: pointer;
  transition: opacity var(--ui-dur-fast, 0.15s) ease, transform var(--ui-dur-instant, 0.12s) ease;
  -webkit-tap-highlight-color: transparent;
}
.hh-pin-confirm[hidden] { display: none; }
.hh-pin-confirm:disabled { opacity: .45; cursor: not-allowed; }
.hh-pin-confirm:not(:disabled):active { transform: scale(.99); }
.hh-pin-confirm:focus-visible { outline: 3px solid var(--ui-primary, #730201); outline-offset: 2px; }
.hh-pin-forgot {
  width: 100%; height: var(--ui-btn-h, 48px); margin-bottom: var(--ui-1, 4px);
  background: transparent; border-radius: var(--ui-radius-sm, 10px);
  border: 1.5px solid rgba(var(--ui-primary-rgb, 115, 2, 1), 0.45);
  font-family: inherit; font-size: 14.5px; font-weight: 700;
  color: var(--ui-primary, #730201); cursor: pointer;
  transition: background var(--ui-dur-instant, 0.12s) ease, opacity var(--ui-dur-fast, 0.15s) ease;
  -webkit-tap-highlight-color: transparent;
}
.hh-pin-forgot:active { background: rgba(var(--ui-primary-rgb, 115, 2, 1), 0.05); }
.hh-pin-forgot:disabled { opacity: .5; cursor: not-allowed; }
.hh-pin-forgot:focus-visible { outline: 3px solid var(--ui-primary, #730201); outline-offset: 2px; }
.hh-pin-foot {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  font-size: 12px; color: var(--ui-faint, #888);
  padding: var(--ui-2, 8px) 0 var(--ui-1, 4px);
}
.hh-pin-foot svg { color: var(--ui-primary, #730201); }
.hh-pin-spinner {
  display: inline-block; width: 15px; height: 15px; margin-right: 8px;
  vertical-align: -3px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff;
  animation: hh-pin-rot .7s linear infinite;
}
@keyframes hh-pin-rot { to { transform: rotate(360deg); } }
.hh-pin-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; border: 0; clip: rect(0 0 0 0); overflow: hidden; white-space: nowrap;
}

/* ── Dark mode ── */
[data-theme="dark"] .hh-pin-back { color: #e05050; }
[data-theme="dark"] .hh-pin-title { color: #f0f0f0; }
[data-theme="dark"] .hh-pin-msg { color: #999; }
[data-theme="dark"] .hh-pin-context { background: rgba(255, 255, 255, 0.07); color: #e05050; }
[data-theme="dark"] .hh-pin-dot { border-color: rgba(255, 255, 255, 0.28); }
[data-theme="dark"] .hh-pin-key { background: #242424; border-color: #303030; box-shadow: none; }
[data-theme="dark"] .hh-pin-key:active, [data-theme="dark"] .hh-pin-key.pressed { background: #2e2020; border-color: #5a2a2a; }
[data-theme="dark"] .hh-pin-key-digit { color: #f0f0f0; }
[data-theme="dark"] .hh-pin-key-letters { color: #777; }
[data-theme="dark"] .hh-pin-key--delete svg { color: #ccc; }
[data-theme="dark"] .hh-pin-forgot { color: #e05050; border-color: rgba(224, 80, 80, 0.5); }
[data-theme="dark"] .hh-pin-foot { color: #666; }
[data-theme="dark"] .hh-pin-foot svg { color: #e05050; }

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .hh-pin-dot.filled, .hh-pin-dots.error { animation: none; }
  .hh-pin-key, .hh-pin-confirm, .hh-pin-head { transition: none; }
  .hh-pin-spinner { animation-duration: 1.4s; }
}
`;
    document.head.appendChild(style);
}

let _seq = 0;

/**
 * Open the Security PIN sheet.
 *
 * @param {object}   options
 * @param {'enter'|'create'} [options.mode='enter']
 * @param {string}   [options.title]         enter-mode title (default 'Enter your PIN')
 * @param {string}   [options.message]       enter-mode supporting copy
 * @param {string}   [options.confirmLabel]  enter: confirm label (default 'Confirm');
 *                                           create: final-step label (default 'Create PIN')
 * @param {string}   [options.context]       optional context chip, e.g. 'Top-up · GHS 50.00'
 * @param {number}   [options.pinLength=4]
 * @param {number}   [options.idleTimeoutMs=120000]  auto-close after inactivity (0 disables)
 * @param {Function} [options.onConfirm]     enter mode: (pin, controls)
 * @param {Function} [options.onCreate]      create mode: (pin, controls) after both entries match
 * @param {Function} [options.onForgot]      enter mode only: renders outlined 'Forgot PIN?'
 * @param {Function} [options.onDismiss]     (reason) — closed without completing
 * @returns {Promise<{ close, setBusy, showError, clear, sheet }>}
 */
export async function openSecurityPinSheet({
    mode = 'enter',
    title = 'Enter your PIN',
    message = 'Enter your 4-digit Handy Hub Security PIN.',
    confirmLabel = '',
    context = '',
    pinLength = 4,
    idleTimeoutMs = 120000,
    onConfirm = null,
    onCreate = null,
    onForgot = null,
    onDismiss = null,
} = {}) {
    injectStyles();

    const isCreate = mode === 'create';
    const steps = isCreate
        ? [
            {
                title:   'Create your PIN',
                message: `Create a ${pinLength}-digit Handy Hub Security PIN to protect wallet top-ups and sensitive account actions.`,
                confirm: 'Continue',
            },
            {
                title:   'Confirm your PIN',
                message: `Enter the same ${pinLength}-digit PIN again to confirm.`,
                confirm: confirmLabel || 'Create PIN',
            },
        ]
        : [{ title, message, confirm: confirmLabel || 'Confirm' }];

    const iid     = ++_seq;
    const titleId = `hh-pin-title-${iid}`;
    const msgId   = `hh-pin-msg-${iid}`;
    const showForgot = !isCreate && typeof onForgot === 'function';

    const root = document.createElement('div');
    root.className = 'hh-pin';
    root.innerHTML = `
      <button class="hh-pin-back" type="button" hidden
              aria-label="Go back and re-enter your new PIN">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>Back
      </button>
      <div class="hh-pin-head">
        <h2 class="hh-pin-title" id="${titleId}">${esc(steps[0].title)}</h2>
        <p class="hh-pin-msg" id="${msgId}">${esc(steps[0].message)}</p>
      </div>
      ${context ? `<div class="hh-pin-context">${LOCK_SVG}${esc(context)}</div>` : ''}
      <div class="hh-pin-entry">
        <div class="hh-pin-dots" aria-hidden="true">${'<span class="hh-pin-dot"></span>'.repeat(pinLength)}</div>
        <input class="hh-pin-input" type="password" inputmode="numeric" pattern="[0-9]*"
               maxlength="${pinLength}" autocomplete="off" autocorrect="off"
               autocapitalize="off" spellcheck="false" enterkeyhint="done"
               aria-label="${esc(steps[0].title)}" aria-describedby="${msgId}" />
      </div>
      <p class="hh-pin-error"></p>
      <span class="hh-pin-sr" aria-live="polite"></span>
      <button class="hh-pin-confirm" type="button" disabled></button>
      ${showForgot ? '<button class="hh-pin-forgot" type="button">Forgot PIN?</button>' : ''}
      <div class="hh-pin-foot">
        ${LOCK_SVG}
        <span>Your Handy Hub Security PIN is encrypted and never shared.</span>
      </div>`;

    const backBtn    = root.querySelector('.hh-pin-back');
    const headEl     = root.querySelector('.hh-pin-head');
    const titleEl    = root.querySelector('.hh-pin-title');
    const msgEl      = root.querySelector('.hh-pin-msg');
    const dotsEl     = root.querySelector('.hh-pin-dots');
    const dots       = Array.from(root.querySelectorAll('.hh-pin-dot'));
    const errEl      = root.querySelector('.hh-pin-error');
    const srEl       = root.querySelector('.hh-pin-sr');
    const inputEl    = root.querySelector('.hh-pin-input');
    const confirmBtn = root.querySelector('.hh-pin-confirm');
    const forgotBtn  = root.querySelector('.hh-pin-forgot');

    // ── Secret state (closure only — see security notes in the header) ────────
    let digits    = [];
    let firstPin  = null;      // create mode: step-1 entry, wiped ASAP
    let stepIndex = 0;
    let busy      = false;
    let sheetHandle = null;
    let idleTimer = null;
    let released  = false;     // shell handed to a later step (see controls.release)

    confirmBtn.textContent = steps[0].confirm;
    // Create step 1 has NO confirm button at all — the 4th digit auto-advances.
    // The button exists only on the confirmation step ('Create PIN') and in
    // enter mode.
    confirmBtn.hidden = isCreate;

    function wipeSecrets() {
        digits   = [];
        firstPin = null;
        // The system keyboard means the PIN also lives in an input value, so the
        // DOM must be scrubbed on every exit path, not just the closure.
        if (inputEl) inputEl.value = '';
    }

    function announce(msg) { srEl.textContent = msg; }

    function resetIdle() {
        if (!idleTimeoutMs) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (busy) { resetIdle(); return; }      // never interrupt a live request
            sheetHandle?.close('timeout');
        }, idleTimeoutMs);
    }

    // Wipe secrets the moment the app is backgrounded or the page unloads.
    function onHidden() {
        if (document.visibilityState === 'hidden') { wipeSecrets(); updateUI(); }
    }
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', wipeSecrets);

    function updateUI() {
        dots.forEach((d, i) => d.classList.toggle('filled', i < digits.length));
        confirmBtn.disabled = busy || digits.length !== pinLength;
        if (inputEl.value !== digits.join('')) inputEl.value = digits.join('');
    }

    /** Re-raise the system keyboard after the sheet is already open (step change,
     *  retry after an error, tapping the indicators). The initial raise is done
     *  synchronously by sheet.js inside the opening gesture. */
    function focusEntry() {
        if (busy) return;
        try { inputEl.focus({ preventScroll: true }); } catch (_) { /* non-fatal */ }
    }

    // The input is the entry surface, but `digits` stays the source of truth:
    // the value is mirrored, sanitised, and wiped on every exit path.
    function onInput() {
        if (busy) { updateUI(); return; }
        const clean = (inputEl.value || '').replace(/\D/g, '').slice(0, pinLength);
        if (clean !== inputEl.value) inputEl.value = clean;
        if (clean.length && errEl.textContent) errEl.textContent = '';
        digits = clean.split('');
        updateUI();
        resetIdle();
        announce(`${digits.length} of ${pinLength} digits entered`);

        // Create step 1 auto-advances: the 4th digit moves straight to the
        // confirmation step — no Continue press. The short beat lets the 4th
        // indicator fill and leaves a delete escape hatch; the guards make a
        // stale timer a no-op (step moved, digit deleted, busy, or closed).
        if (isCreate && stepIndex === 0 && digits.length === pinLength) {
            setTimeout(() => {
                if (!busy && stepIndex === 0 && digits.length === pinLength) submit();
            }, 280);
        }
    }

    function clearAll() {
        if (busy) return;
        digits = [];
        updateUI();
        resetIdle();
        announce('PIN cleared');
    }

    // Morph the header copy for multi-step flows (create → confirm).
    function goToStep(i) {
        stepIndex = i;
        digits = [];
        inputEl.value = '';
        errEl.textContent = '';
        // Back is offered only on the confirmation step — it returns to step 1
        // to re-enter a different PIN (the first entry is wiped on the way).
        backBtn.hidden = !(isCreate && i === 1);
        headEl.classList.add('morph');
        setTimeout(() => {
            titleEl.textContent   = steps[i].title;
            msgEl.textContent     = steps[i].message;
            confirmBtn.textContent = steps[i].confirm;
            confirmBtn.hidden      = isCreate && i === 0;   // no button on the create step
            inputEl.setAttribute('aria-label', steps[i].title);
            updateUI();
            headEl.classList.remove('morph');
            announce(steps[i].title + '. ' + steps[i].message);
            focusEntry();               // keep the keyboard up across the step change
        }, 170);
    }

    function goBackToCreate() {
        if (busy || !isCreate || stepIndex !== 1) return;
        firstPin = null;               // re-entering — wipe the temporary copy
        goToStep(0);
    }

    const controls = {
        close(reason = 'close') { sheetHandle?.close(reason); },

        /** The underlying sheet handle — lets a caller morph this shell into the
         *  next step of the journey (see sheet.js replaceContent). */
        get sheet() { return sheetHandle; },

        /**
         * Hand the shell to the next step WITHOUT closing it: stop the idle
         * timer, drop the background/unload listeners, wipe every secret, and
         * stop claiming onDismiss. Call this immediately before morphing the
         * sheet into another step, so a stale PIN timer can never close a sheet
         * that now belongs to a payment in flight.
         */
        release() {
            released = true;
            clearTimeout(idleTimer);
            idleTimer = null;
            document.removeEventListener('visibilitychange', onHidden);
            window.removeEventListener('pagehide', wipeSecrets);
            wipeSecrets();
        },

        /** Disable all input while the caller works (server request in flight).
         *  Disabling the entry also dismisses the system keyboard, which is the
         *  right signal: nothing is typeable until the server answers. */
        setBusy(b) {
            busy = Boolean(b);
            inputEl.disabled = busy;
            if (forgotBtn) forgotBtn.disabled = busy;
            if (busy) {
                confirmBtn.disabled  = true;
                confirmBtn.innerHTML = '<span class="hh-pin-spinner" aria-hidden="true"></span>Please wait…';
            } else {
                confirmBtn.textContent = steps[stepIndex].confirm;
                updateUI();
                focusEntry();          // hand the keyboard back for a retry
            }
            resetIdle();
        },

        /** Wrong-PIN / mismatch feedback: safe message + shake, entry resets. */
        showError(msg) {
            controls.setBusy(false);
            errEl.textContent = msg || 'Incorrect PIN. Please try again.';
            errEl.setAttribute('role', 'alert');
            dotsEl.classList.remove('error');
            void dotsEl.offsetWidth;               // restart the shake animation
            dotsEl.classList.add('error');
            setTimeout(() => {
                dotsEl.classList.remove('error');
                digits = [];
                inputEl.value = '';
                updateUI();
                focusEntry();          // ready to retype immediately
            }, 480);
        },

        clear() {
            errEl.textContent = '';
            clearAll();
        },
    };

    function submit() {
        if (busy || digits.length !== pinLength) return;
        errEl.textContent = '';
        resetIdle();
        const pin = digits.join('');   // exists only for this call — never stored

        if (!isCreate) {
            if (typeof onConfirm === 'function') onConfirm(pin, controls);
            else controls.close('confirmed');
            return;
        }

        if (stepIndex === 0) {
            firstPin = pin;
            goToStep(1);
            return;
        }

        // Create mode, confirmation step.
        if (pin !== firstPin) {
            controls.showError("The PINs don't match. Try again.");
            return;
        }
        firstPin = null;               // matched — wipe the temporary copy NOW
        if (typeof onCreate === 'function') onCreate(pin, controls);
        else controls.close('created');
    }

    // ── System-keyboard entry ──────────────────────────────────────────────────
    // The OS keypad is the input device: `input` covers typing, paste, autofill
    // and the on-screen delete key uniformly, on every platform.
    inputEl.addEventListener('input', onInput);
    // Backspace on an empty confirmation entry steps back to re-enter the new
    // PIN — mirroring the visible Back affordance.
    inputEl.addEventListener('keydown', (e) => {
        if (busy) return;
        if (e.key === 'Backspace' && !digits.length && isCreate && stepIndex === 1) {
            e.preventDefault();
            goBackToCreate();
        } else if (e.key === 'Enter' && digits.length === pinLength) {
            e.preventDefault();
            submit();
        }
    });
    // Tapping the indicators re-raises the keyboard if it was dismissed.
    dotsEl.addEventListener('click', focusEntry);

    confirmBtn.addEventListener('click', submit);
    backBtn.addEventListener('click', goBackToCreate);
    if (forgotBtn) forgotBtn.addEventListener('click', () => onForgot(controls));

    sheetHandle = await openSheet({
        id: 'hh-security-pin',
        content: root,
        labelledBy: titleId,
        describedBy: msgId,
        dismissible: { backdrop: true, swipe: true, escape: true },
        // Focus the entry itself so the system keyboard is up and ready to type
        // the moment the sheet lands.
        initialFocus: '.hh-pin-input',
        onClose(reason) {
            wipeSecrets();
            inputEl.value = '';          // never leave the PIN in the DOM
            clearTimeout(idleTimer);
            document.removeEventListener('visibilitychange', onHidden);
            window.removeEventListener('pagehide', wipeSecrets);
            // A released shell belongs to a later step — that step owns its own
            // teardown, so this flow must not report a dismissal for it.
            if (released) return;
            const completed = reason === 'confirmed' || reason === 'created' || reason === 'forgot';
            if (!completed && typeof onDismiss === 'function') onDismiss(reason);
        },
    });

    // sheet.js already focused the entry synchronously inside the opening gesture
    // (that is what makes the keyboard appear instantly, with no tap). Do NOT
    // re-focus from a timer here: on iOS a focus() outside the gesture is a no-op
    // that can dismiss the keyboard it was meant to raise.

    updateUI();
    resetIdle();
    return { ...controls, sheet: sheetHandle };
}
