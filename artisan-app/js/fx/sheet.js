/**
 * artisan-app/js/fx/sheet.js — the bottom sheet's behaviour (Phase 1).
 *
 * Markup (a direct child of <body>, hidden until opened):
 *   <div class="fx-overlay" id="…" hidden>
 *     <button type="button" class="fx-scrim" tabindex="-1" aria-label="Close"></button>
 *     <section class="fx-sheet" role="dialog" aria-modal="true" aria-labelledby="…" tabindex="-1">
 *       <header class="fx-sheet__head"><h2 class="fx-sheet__title" id="…">…</h2> [close .fx-iconbtn data-sheet-close]</header>
 *       <div class="fx-sheet__body">…</div>
 *       <footer class="fx-sheet__actions">…</footer>
 *     </section>
 *   </div>
 *
 * openSheet() makes it a real modal: everything else in <body> becomes inert
 * (unreachable by Tab, pointer or screen reader), the page stops scrolling,
 * focus moves to [data-autofocus] or the sheet, Tab cycles inside, Escape, the
 * scrim and any [data-sheet-close] close it, and focus returns to whatever
 * opened it. The Workbench prototype's offer sheet did none of this (Phase 0:
 * 28 background tab stops).
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

/** The focusable elements inside `root`, in tab order, that can actually take focus. */
export function focusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && !el.closest('[inert]') && el.getClientRects().length > 0);
}

/**
 * Open an .fx-overlay as a modal sheet.
 * @param {HTMLElement} overlay
 * @param {{ onClose?: (reason: string) => void, dismissible?: boolean }} [opts]
 * @returns {{ close: (reason?: string) => Promise<void>, el: HTMLElement }}
 */
export function openSheet(overlay, opts = {}) {
    const { onClose = null, dismissible = true } = opts;
    const doc = overlay.ownerDocument;
    const sheet = overlay.querySelector('.fx-sheet');
    const opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;

    // Everything else in <body> leaves the accessibility tree and the tab order.
    const madeInert = [];
    for (const el of doc.body.children) {
        if (el === overlay || el.inert || el.tagName === 'SCRIPT') continue;
        el.inert = true;
        madeInert.push(el);
    }
    doc.documentElement.classList.add('fx-lock');
    overlay.removeAttribute('data-state');
    overlay.hidden = false;

    const first = overlay.querySelector('[data-autofocus]') || sheet;
    first.focus({ preventScroll: true });

    let closed = false;
    function onKey(e) {
        if (e.key === 'Escape' && dismissible) { e.preventDefault(); close('escape'); return; }
        if (e.key !== 'Tab') return;
        const items = focusables(sheet);
        if (!items.length) { e.preventDefault(); sheet.focus(); return; }
        const firstItem = items[0], last = items[items.length - 1];
        const active = doc.activeElement;
        if (e.shiftKey && (active === firstItem || active === sheet)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); firstItem.focus(); }
    }
    function onClick(e) {
        if (e.target.closest('[data-sheet-close]') || (dismissible && e.target.classList.contains('fx-scrim'))) close('dismiss');
    }
    overlay.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onClick);

    function close(reason = 'close') {
        if (closed) return Promise.resolve();
        closed = true;
        overlay.removeEventListener('keydown', onKey);
        overlay.removeEventListener('click', onClick);
        const finish = () => {
            overlay.hidden = true;
            overlay.removeAttribute('data-state');
            for (const el of madeInert) el.inert = false;
            doc.documentElement.classList.remove('fx-lock');
            if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
            if (onClose) onClose(reason);
        };
        if (reducedMotion()) { finish(); return Promise.resolve(); }
        overlay.setAttribute('data-state', 'closing');
        return new Promise((resolve) => {
            let done = false;
            const end = () => { if (done) return; done = true; finish(); resolve(); };
            sheet.addEventListener('animationend', end, { once: true });
            setTimeout(end, 400);   // never stuck open if no animation runs
        });
    }
    return { close, el: overlay };
}
