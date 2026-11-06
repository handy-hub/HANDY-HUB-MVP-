/**
 * artisan-app/js/fx/toast.js — short confirmations (Phase 1).
 *
 *   showToast('Quote sent', { tone: 'ok' })
 *   showToast('Could not save. Check your connection.', { tone: 'bad', action: { label: 'Retry', onClick } })
 *
 * Toasts appear below the app bar, never over the action under the thumb. They
 * are announced through a polite live region (role="status"); a 'bad' toast is
 * role="alert". The timer pauses while the toast is hovered or holds focus, and
 * a toast with an action stays until it is used or dismissed — nobody should
 * have to race a timer to press "Retry". At most two are shown.
 */
import { icon } from './icons.js';

const ICONS = { ok: 'check', info: 'info', warn: 'alert', bad: 'alert' };
const MAX = 2;

function region(doc) {
    let el = doc.querySelector('.fx-toasts');
    if (!el) {
        el = doc.createElement('div');
        el.className = 'fx-toasts';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        doc.body.appendChild(el);
    }
    return el;
}

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

/**
 * @param {string} message
 * @param {{ tone?: 'ok'|'info'|'warn'|'bad', action?: {label: string, onClick: Function}, timeoutMs?: number, doc?: Document }} [opts]
 * @returns {{ el: HTMLElement, dismiss: () => void }}
 */
export function showToast(message, opts = {}) {
    const { tone = 'info', action = null, timeoutMs = 4000, doc = document } = opts;
    const host = region(doc);
    while (host.children.length >= MAX) host.firstElementChild.remove();

    const el = doc.createElement('div');
    el.className = 'fx-toast';
    el.dataset.tone = tone;
    if (tone === 'bad') el.setAttribute('role', 'alert');
    el.innerHTML = `${icon(ICONS[tone] || 'info', 'fx-toast__icon')}<p class="fx-toast__text"></p>`;
    el.querySelector('.fx-toast__text').textContent = message;   // never HTML from callers
    if (action) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'fx-toast__action';
        b.textContent = action.label;
        b.addEventListener('click', () => { try { action.onClick(); } finally { dismiss(); } });
        el.appendChild(b);
    }
    host.appendChild(el);

    let timer = null;
    let gone = false;
    function dismiss() {
        if (gone) return;
        gone = true;
        clearTimeout(timer);
        if (reducedMotion()) { el.remove(); return; }
        el.dataset.state = 'closing';
        setTimeout(() => el.remove(), 200);
    }
    const arm = () => { if (!action && timeoutMs > 0) timer = setTimeout(dismiss, timeoutMs); };
    const pause = () => clearTimeout(timer);
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', arm);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', arm);
    arm();
    return { el, dismiss };
}
