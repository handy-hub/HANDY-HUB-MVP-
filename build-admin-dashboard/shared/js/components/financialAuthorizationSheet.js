/**
 * Reusable financial-authorization state sheet — the step AFTER the Security
 * PIN in the wallet top-up journey, and reusable for any future payment state.
 *
 * The canonical sheet controller owns overlay, stacking, motion, focus, scroll
 * lock, swipe, safe-area and teardown. This component owns only the changing
 * financial-state content rendered inside that shell.
 *
 * Continuity: pass an existing `sheet` handle (e.g. the Security PIN sheet's,
 * via `controls.sheet` after `controls.release()`) and this MORPHS that shell
 * instead of opening a second one — the PIN step becomes the authorization step
 * with the sheet never leaving the screen. Omit `sheet` to open standalone.
 *
 * One component, many states (waiting → approved → confirmed | failed |
 * timed_out | cancelled | unreachable). Only the content changes: layout,
 * typography, spacing, motion, overlay and a11y stay identical throughout.
 */
import { openSheet } from './sheet.js';

const STATE_COPY = {
    waiting: {
        title: 'Waiting for Payment Authorization',
        message: 'We have securely initiated your wallet top-up. Approve the Mobile Money prompt on your phone to continue.',
        live: 'Waiting for payment authorization on your phone.',
        action: 'Cancel Top Up',
    },
    approved: {
        title: 'Authorization Received',
        message: 'Your approval was received. We are confirming your top-up.',
        live: 'Payment authorization received.',
        action: '',
    },
    confirmed: {
        title: 'Top Up Confirmed',
        message: 'Your wallet has been credited.',
        live: 'Top up confirmed. Your wallet has been credited.',
        action: 'Done',
    },
    failed: {
        title: 'Payment Could Not Be Authorized',
        message: 'Your wallet was not charged. Check your details and try again.',
        live: 'Payment authorization failed.',
        action: 'Try Again',
    },
    timed_out: {
        title: 'Authorization Timed Out',
        message: 'The request took too long. Your wallet was not charged.',
        live: 'Payment authorization timed out.',
        action: 'Try Again',
    },
    cancelled: {
        title: 'Top Up Cancelled',
        message: 'The authorization request was cancelled. Your wallet was not charged.',
        live: 'Top up cancelled.',
        action: 'Close',
    },
    unreachable: {
        title: 'Unable to Contact Provider',
        message: 'Check your connection and try again in a moment.',
        live: 'Unable to contact the payment provider.',
        action: 'Try Again',
    },
};

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ensureStyles() {
    if (document.getElementById('hh-fin-auth-styles')) return;
    const style = document.createElement('style');
    style.id = 'hh-fin-auth-styles';
    style.textContent = `
.hh-fin-auth { padding: var(--ui-3, 12px) var(--ui-modal-pad-inline, 24px) 0; color: var(--ui-text, #111); text-align: center; }
.hh-fin-auth__progress { position: relative; display: grid; place-items: center; width: 112px; height: 112px; margin: var(--ui-8, 32px) auto var(--ui-5, 20px); border-radius: var(--ui-radius-pill, 999px); background: rgba(var(--ui-primary-rgb,115,2,1),.045); }
.hh-fin-auth__progress svg { width: 72px; height: 72px; transform: rotate(-90deg); }
.hh-fin-auth__track, .hh-fin-auth__arc { fill: none; stroke-width: 7; }
.hh-fin-auth__track { stroke: rgba(var(--ui-primary-rgb,115,2,1),.12); }
.hh-fin-auth__arc { stroke: var(--ui-primary,#730201); stroke-linecap: round; stroke-dasharray: 112 176; animation: hh-fin-auth-spin 1.15s linear infinite; transform-origin: center; }
@keyframes hh-fin-auth-spin { to { transform: rotate(360deg); } }
/* Title/body follow the canonical modal type scale — identical to the Security
   PIN sheet, so the journey never changes voice. See MODAL_DESIGN_SYSTEM.md §2. */
.hh-fin-auth__title { margin: 0; font-size: var(--ui-modal-title-size, 18px); line-height: var(--ui-modal-title-lh, 1.25); font-weight: var(--ui-modal-title-weight, 800); }
.hh-fin-auth__message { max-width: 330px; margin: var(--ui-3,12px) auto 0; color: var(--ui-muted,#666); font-size: var(--ui-modal-body-size, 13.5px); line-height: var(--ui-modal-body-lh, 1.55); }
.hh-fin-auth__context { margin: var(--ui-2,8px) auto 0; color: var(--ui-text,#111); font-size: 13px; font-weight: 700; }
.hh-fin-auth__divider { height: 1px; margin: var(--ui-8,32px) 0 var(--ui-5,20px); background: var(--ui-border,rgba(0,0,0,.08)); }
.hh-fin-auth__info { padding: var(--ui-5,20px); border-radius: var(--ui-radius-lg,18px); background: rgba(var(--ui-primary-rgb,115,2,1),.045); text-align: left; }
.hh-fin-auth__info h3 { margin: 0 0 var(--ui-4,16px); font-size: 14.5px; font-weight: 800; }
.hh-fin-auth__item { display: grid; grid-template-columns: 24px 1fr; gap: var(--ui-3,12px); align-items: start; margin-top: var(--ui-3,12px); color: var(--ui-muted,#666); font-size: var(--ui-modal-body-size, 13.5px); line-height: var(--ui-modal-body-lh, 1.55); }
.hh-fin-auth__item svg { width: 20px; height: 20px; color: var(--ui-primary,#730201); }
/* Same treatment as the PIN sheet's secondary action. font-family is INHERITED —
   a modal never sets it (MODAL_DESIGN_SYSTEM.md §2). */
.hh-fin-auth__action { width: 100%; min-height: var(--ui-btn-h,48px); margin-top: var(--ui-6,24px); border: 1.5px solid var(--ui-primary,#730201); border-radius: var(--ui-radius-sm,10px); background: transparent; color: var(--ui-primary,#730201); font-family: inherit; font-size: 14.5px; font-weight: 700; cursor: pointer; transition: background var(--ui-dur-instant,.12s) ease; }
.hh-fin-auth__action:active { background: rgba(var(--ui-primary-rgb,115,2,1),.05); }
.hh-fin-auth__action:focus-visible { outline: 3px solid rgba(var(--ui-primary-rgb,115,2,1),.25); outline-offset: 2px; }
.hh-fin-auth__action[hidden] { display: none; }
.hh-fin-auth__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
[data-theme="dark"] .hh-fin-auth { color: #f0f0f0; }
[data-theme="dark"] .hh-fin-auth__message, [data-theme="dark"] .hh-fin-auth__item { color: #aaa; }
[data-theme="dark"] .hh-fin-auth__context { color: #e0e0e0; }
@media (prefers-reduced-motion: reduce) { .hh-fin-auth__arc { animation-duration: 2.3s; } }
`;
    document.head.appendChild(style);
}

const PHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M9 18h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SIGNAL_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5a10 10 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

export async function openFinancialAuthorizationSheet({
    state = 'waiting', amount = '', provider = '', phone = '',
    onCancel = null, onRetry = null, onClose = null,
    sheet = null,   // existing handle to morph — keeps the journey continuous
} = {}) {
    ensureStyles();
    const iid = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const titleId = `hh-fin-auth-title-${iid}`;
    const messageId = `hh-fin-auth-message-${iid}`;
    const root = document.createElement('div');
    root.className = 'hh-fin-auth';
    root.innerHTML = `
      <div class="hh-fin-auth__progress" role="progressbar" aria-label="Waiting for payment authorization">
        <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="hh-fin-auth__track" cx="32" cy="32" r="24"/><circle class="hh-fin-auth__arc" cx="32" cy="32" r="24"/></svg>
      </div>
      <h2 class="hh-fin-auth__title" id="${titleId}"></h2>
      <p class="hh-fin-auth__message" id="${messageId}"></p>
      <p class="hh-fin-auth__context">${esc([provider, phone].filter(Boolean).join(' · '))}${amount ? ` · ${esc(amount)}` : ''}</p>
      <p class="hh-fin-auth__sr" aria-live="polite" aria-atomic="true"></p>
      <div class="hh-fin-auth__divider"></div>
      <section class="hh-fin-auth__info" aria-label="What to expect">
        <h3>What to expect</h3>
        <div class="hh-fin-auth__item">${PHONE_SVG}<span>Approve the Mobile Money prompt on your phone.</span></div>
        <div class="hh-fin-auth__item">${SIGNAL_SVG}<span>Keep Handy Hub open and stay connected while authorization is pending.</span></div>
        <div class="hh-fin-auth__item">${CLOCK_SVG}<span>This usually takes only a few moments.</span></div>
      </section>
      <button class="hh-fin-auth__action" type="button"></button>`;

    const title = root.querySelector('.hh-fin-auth__title');
    const message = root.querySelector('.hh-fin-auth__message');
    const live = root.querySelector('.hh-fin-auth__sr');
    const action = root.querySelector('.hh-fin-auth__action');
    const progress = root.querySelector('.hh-fin-auth__progress');
    let currentState = '';
    let handle;

    function setState(next, overrides = {}) {
        const copy = { ...(STATE_COPY[next] || STATE_COPY.waiting), ...overrides };
        currentState = next;
        title.textContent = copy.title;
        message.textContent = copy.message;
        live.textContent = copy.live;
        action.textContent = copy.action || '';
        action.hidden = !copy.action;
        progress.hidden = next !== 'waiting' && next !== 'approved';
        progress.setAttribute('aria-label', copy.live);
    }
    setState(state);

    action.addEventListener('click', () => {
        if (currentState === 'waiting') {
            if (typeof onCancel === 'function') onCancel(api);
            else handle?.close('cancelled');
        } else if (currentState === 'failed' || currentState === 'timed_out' || currentState === 'unreachable') {
            if (typeof onRetry === 'function') onRetry(api);
        } else handle?.close('done');
    });

    // Dismissal is locked while money is in flight: the customer must resolve the
    // authorization through the sheet's own action, never by tapping away.
    const LOCKED = { backdrop: false, swipe: false, escape: false };

    if (sheet) {
        // Continue the journey inside the shell we were handed — the sheet never
        // leaves the screen, so this reads as the PIN step advancing.
        handle = sheet;
        handle.setDismissible(LOCKED);
        handle.setOnClose(onClose);
        handle.replaceContent(root, {
            labelledBy: titleId,
            describedBy: messageId,
            initialFocus: '.hh-fin-auth__action',
        });
    } else {
        handle = await openSheet({
            id: 'hh-financial-authorization', content: root,
            labelledBy: titleId, describedBy: messageId,
            dismissible: LOCKED,
            onClose,
            initialFocus: '.hh-fin-auth__action',
        });
    }

    const api = { ...handle, setState, getState: () => currentState };
    return api;
}
