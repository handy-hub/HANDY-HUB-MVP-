/**
 * sheet.js — lifecycle controller for the canonical HandyHub bottom sheet.
 *
 * shared/css/components/sheet.css defines the ONE visual contract for bottom
 * sheets (.ui-sheet-overlay / .ui-sheet / .ui-sheet-handle) but, until now, had
 * no JS counterpart — every consumer hand-rolled its own open/close, and none
 * implemented focus management. This module completes the system:
 *
 *   • mounts/unmounts the canonical markup (never a parallel implementation)
 *   • entry/exit via the .open class → sheet.css owns ALL motion tokens
 *   • body scroll lock with stacking-safe lock counting
 *   • focus trap (Tab/Shift+Tab), Escape-to-dismiss, focus restore to trigger
 *   • backdrop-tap dismiss; swipe-down via the ONE gesture engine
 *     (shared/js/utils/sheetDismiss.js — never reimplemented here)
 *   • sequential/stacked sheets: only the topmost receives Escape/Tab handling
 *   • multi-step journeys: replaceContent() morphs the content while the SHELL
 *     stays on screen, plus runtime setDismissible()/setOnClose() so a step can
 *     lock the sheet (payment in flight) and own its own teardown
 *   • duplicate prevention by id; full DOM cleanup after the exit transition
 *   • self-sufficient styling: links the canonical sheet.css if the host page
 *     hasn't already (one <link> to the ONE file — styles are never duplicated)
 *
 * Usage:
 *   import { openSheet } from '../shared/js/components/sheet.js';
 *   const sheet = await openSheet({
 *     id: 'filters',
 *     content: myElement,               // HTMLElement or trusted HTML string
 *     labelledBy: 'filters-title',
 *     onClose: (reason) => {},          // 'backdrop'|'swipe'|'escape'|custom
 *   });
 *   sheet.close('done');
 */

import { attachSwipeDismiss } from '../utils/sheetDismiss.js';

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

const _stack = [];
let _locks = 0;
let _cssReady = null;

function _lockScroll() {
    // overflow:hidden matches the app's established convention (modal.js,
    // paymentMethodsModal) — pages here scroll inside .scroll-area containers,
    // so body position tricks are unnecessary. Counting makes stacking safe.
    if (++_locks === 1) document.body.style.overflow = 'hidden';
}

function _unlockScroll() {
    _locks = Math.max(0, _locks - 1);
    if (_locks === 0) document.body.style.overflow = '';
}

function _ensureCss() {
    if (_cssReady) return _cssReady;
    if (document.querySelector('link[href*="components/sheet.css"]')) {
        _cssReady = Promise.resolve();
        return _cssReady;
    }
    _cssReady = new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel  = 'stylesheet';
        link.href = new URL('../../css/components/sheet.css', import.meta.url).href;
        link.onload = link.onerror = () => resolve();
        document.head.appendChild(link);
        setTimeout(resolve, 300);   // fail-open: never block a sheet on a slow link
    });
    return _cssReady;
}

// Start loading at IMPORT time, not at open time. openSheet() must not wait on a
// network round-trip inside the user's gesture: iOS only raises the system
// keyboard for focus that happens during that gesture, and an unresolved await
// would push focus past it. Pages that use sheets should also <link> sheet.css
// directly, which makes this resolve instantly.
_ensureCss();

/** Lift the sheet above the on-screen keyboard.
 *  The OS keyboard overlays a fixed-position sheet rather than resizing the
 *  layout viewport, so we measure the visual viewport and expose the covered
 *  height as --ui-kb-inset; sheet.css turns that into bottom padding + a smaller
 *  max-height, keeping the whole sheet visible and reachable. */
function _trackKeyboard(overlay) {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const sync = () => {
        const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        overlay.style.setProperty('--ui-kb-inset', `${Math.round(covered)}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
        vv.removeEventListener('resize', sync);
        vv.removeEventListener('scroll', sync);
    };
}

/**
 * Open a canonical bottom sheet.
 *
 * @param {object}  options
 * @param {string}  [options.id]           Dedupe key — reopening an open id returns the existing handle
 * @param {HTMLElement|string} options.content  Sheet body (trusted markup only — escape dynamic values)
 * @param {string}  [options.label]        aria-label when no visible title exists
 * @param {string}  [options.labelledBy]   id of the visible title element
 * @param {string}  [options.describedBy]  id of the supporting copy element
 * @param {boolean} [options.showHandle=true]
 * @param {object}  [options.dismissible]  { backdrop=true, swipe=true, escape=true }
 * @param {Function}[options.onClose]      Called once, after full teardown, with the close reason
 * @param {string|HTMLElement} [options.initialFocus='self']  'self' | selector | element
 * @returns {Promise<{ el, overlay, close(reason), isOpen() }>}
 */
export async function openSheet({
    id = null,
    content,
    label = '',
    labelledBy = '',
    describedBy = '',
    showHandle = true,
    dismissible = {},
    onClose = null,
    initialFocus = 'self',
} = {}) {
    // Mutable so a later step in the same sheet can lock/unlock dismissal
    // at runtime via api.setDismissible() — see replaceContent().
    const dismiss = { backdrop: true, swipe: true, escape: true, ...dismissible };
    let closeHandler = onClose;

    if (id) {
        const dup = _stack.find(s => s.id === id);
        if (dup) return dup.api;
    }

    await _ensureCss();

    // ── Canonical markup (sheet.css contract) ────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'ui-sheet-overlay';
    overlay.setAttribute('role', 'presentation');

    const sheet = document.createElement('div');
    sheet.className = 'ui-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    if (labelledBy)      sheet.setAttribute('aria-labelledby', labelledBy);
    else if (label)      sheet.setAttribute('aria-label', label);
    if (describedBy)     sheet.setAttribute('aria-describedby', describedBy);
    sheet.tabIndex = -1;

    if (showHandle) {
        const handle = document.createElement('div');
        handle.className = 'ui-sheet-handle';
        handle.setAttribute('aria-hidden', 'true');
        sheet.appendChild(handle);
    }
    if (typeof content === 'string')  sheet.insertAdjacentHTML('beforeend', content);
    else if (content)                 sheet.appendChild(content);

    overlay.appendChild(sheet);

    const trigger = document.activeElement;
    const entry   = { id, api: null };
    let closing   = false;

    function onKeydown(e) {
        if (_stack[_stack.length - 1] !== entry) return;   // topmost sheet only
        if (e.key === 'Escape' && dismiss.escape) {
            e.preventDefault();
            close('escape');
            return;
        }
        if (e.key !== 'Tab') return;
        const focusable = Array.from(sheet.querySelectorAll(FOCUSABLE))
            .filter(el => el.offsetParent !== null);
        if (!focusable.length) { e.preventDefault(); sheet.focus(); return; }
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        } else if (!sheet.contains(document.activeElement)) {
            e.preventDefault(); first.focus();
        }
    }

    function close(reason = 'close') {
        if (closing) return;
        closing = true;
        document.removeEventListener('keydown', onKeydown, true);
        untrackKeyboard();
        overlay.classList.remove('open');

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            overlay.remove();
            _unlockScroll();
            const i = _stack.indexOf(entry);
            if (i > -1) _stack.splice(i, 1);
            if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
                try { trigger.focus(); } catch (_) { /* trigger gone — non-fatal */ }
            }
            if (typeof closeHandler === 'function') closeHandler(reason);
        };
        // Exit ends when sheet.css's transform transition completes; the timeout
        // covers reduced-motion (near-zero duration) and swipe exits where the
        // gesture engine already moved the sheet off-screen.
        sheet.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, 450);
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay && dismiss.backdrop) close('backdrop');
    });

    document.body.appendChild(overlay);
    _lockScroll();
    const untrackKeyboard = _trackKeyboard(overlay);
    document.addEventListener('keydown', onKeydown, true);
    // Always attached; the guard decides per-gesture so dismissal can be locked
    // at runtime without ever detaching the ONE gesture engine.
    attachSwipeDismiss(overlay, sheet, () => close('swipe'), {
        canDismiss: () => dismiss.swipe,
    });

    // Open + focus SYNCHRONOUSLY, still inside the caller's user gesture.
    // A forced reflow commits the closed state (translateY(100%), hidden) so the
    // entry transition still animates from it — the job rAF used to do — without
    // deferring to a later task. That matters because iOS raises the system
    // keyboard only for focus() that happens during the gesture; focusing from
    // rAF silently produced no keyboard until the user tapped the field.
    void overlay.offsetHeight;
    overlay.classList.add('open');
    void sheet.offsetHeight;          // apply visibility:visible before focusing

    let target = sheet;
    if (initialFocus && initialFocus !== 'self') {
        target = (typeof initialFocus === 'string'
            ? sheet.querySelector(initialFocus)
            : initialFocus) || sheet;
    }
    try { target.focus({ preventScroll: true }); } catch (_) { /* non-fatal */ }

    /**
     * Morph this sheet into its next step. The shell — position, motion, focus
     * trap, scroll lock, swipe engine — stays exactly where it is; only the
     * content changes. This is what makes a multi-step financial journey read as
     * ONE continuous sheet rather than a stack of unrelated modals.
     */
    function replaceContent(next, { labelledBy: lb = '', describedBy: db = '', initialFocus: nf = 'self' } = {}) {
        if (closing) return;
        const keep = showHandle ? sheet.querySelector('.ui-sheet-handle') : null;
        Array.from(sheet.children).forEach(c => { if (c !== keep) c.remove(); });

        let added = null;
        if (typeof next === 'string') {
            const holder = document.createElement('div');
            holder.innerHTML = next;
            added = holder;
            sheet.appendChild(holder);
        } else if (next) {
            added = next;
            sheet.appendChild(next);
        }
        if (added) {
            added.classList.add('ui-sheet-swap-in');
            added.addEventListener('animationend',
                () => added.classList.remove('ui-sheet-swap-in'), { once: true });
        }

        // Re-point the accessible name/description at the new step's elements.
        if (lb) sheet.setAttribute('aria-labelledby', lb);
        else    sheet.removeAttribute('aria-labelledby');
        if (db) sheet.setAttribute('aria-describedby', db);
        else    sheet.removeAttribute('aria-describedby');

        sheet.scrollTop = 0;
        let target = sheet;
        if (nf && nf !== 'self') {
            target = (typeof nf === 'string' ? sheet.querySelector(nf) : nf) || sheet;
        }
        try { target.focus({ preventScroll: true }); } catch (_) { /* non-fatal */ }
    }

    entry.api = {
        el: sheet,
        overlay,
        close,
        isOpen: () => !closing,
        replaceContent,
        /** Lock/unlock dismissal at runtime, e.g. while a payment is in flight. */
        setDismissible(next = {}) { Object.assign(dismiss, next); },
        /** Hand teardown to the step that now owns the sheet. */
        setOnClose(fn) { closeHandler = fn; },
    };
    _stack.push(entry);
    return entry.api;
}
