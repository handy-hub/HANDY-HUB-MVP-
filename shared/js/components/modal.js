/**
 * modal.js — Accessible modal dialog component
 *
 * WCAG 2.2 AA compliant:
 *   - Focus trapped inside the modal while open (Tab / Shift+Tab cycle)
 *   - Escape key closes the modal
 *   - aria-modal="true", role="dialog", aria-labelledby pointing to title
 *   - Focus returns to the trigger element on close
 *   - Scroll lock on <body> while modal is open
 *
 * Usage:
 *   import { openModal, closeModal } from '../shared/js/components/modal.js';
 *
 *   openModal({
 *     title:    'Confirm Cancellation',
 *     content:  '<p>Are you sure you want to cancel this booking?</p>',
 *     actions: [
 *       { label: 'Cancel booking', variant: 'danger',   onClick: () => { doCancel(); closeModal(); } },
 *       { label: 'Keep booking',   variant: 'secondary', onClick: closeModal },
 *     ],
 *   });
 */

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

let _overlay   = null;
let _triggerEl = null;
let _keydownHandler = null;

// ── Styles (injected once) ────────────────────────────────────────────────────

function _injectStyles() {
    if (document.getElementById('hh-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'hh-modal-styles';
    style.textContent = `
#hh-modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--ui-overlay, rgba(0,0,0,0.5));
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--ui-z-modal, 1000);
    padding: 16px;
    animation: hh-modal-fade-in 0.18s ease;
}
@keyframes hh-modal-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
}
#hh-modal-dialog {
    background: var(--ui-surface, #fff);
    border-radius: var(--ui-radius-lg, 18px);
    padding: 24px;
    width: 100%;
    max-width: 420px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    animation: hh-modal-slide-up 0.2s ease;
    position: relative;
}
@keyframes hh-modal-slide-up {
    from { transform: translateY(16px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}
#hh-modal-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--ui-text, #111);
    margin-bottom: 12px;
    line-height: 1.3;
}
#hh-modal-body {
    font-size: 0.9rem;
    color: var(--ui-muted, #444);
    line-height: 1.55;
    margin-bottom: 20px;
}
#hh-modal-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.hh-modal-btn {
    display: block;
    width: 100%;
    height: var(--ui-btn-h, 48px);
    padding: 0 16px;
    border-radius: var(--ui-radius-sm, 10px);
    border: none;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: opacity 0.15s;
}
.hh-modal-btn:hover   { opacity: 0.88; }
.hh-modal-btn:focus-visible {
    outline: 3px solid var(--ui-primary, var(--ds-brand-500, #730201));
    outline-offset: 2px;
}
.hh-modal-btn.danger    { background: var(--ui-danger, #b22222); color: #fff; }
.hh-modal-btn.primary   { background: var(--ui-primary, var(--ds-brand-500, #730201)); color: #fff; }
.hh-modal-btn.secondary { background: var(--ui-border, #f3f3f3); color: var(--ui-text, #333); }
#hh-modal-close-btn {
    position: absolute;
    top: 14px;
    right: 14px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.3rem;
    color: var(--ui-muted, #888);
    line-height: 1;
    padding: 4px 8px;
    border-radius: var(--ui-radius-sm, 10px);
}
#hh-modal-close-btn:focus-visible {
    outline: 3px solid var(--ui-primary, var(--ds-brand-500, #730201));
    outline-offset: 2px;
}
    `;
    document.head.appendChild(style);
}

// ── Focus trap ────────────────────────────────────────────────────────────────

function _trapFocus(e) {
    if (!_overlay) return;
    const focusable = Array.from(_overlay.querySelectorAll(FOCUSABLE));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last  = focusable[focusable.length - 1];

    if (e.key === 'Tab') {
        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    }

    if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open an accessible modal dialog.
 *
 * @param {object}   options
 * @param {string}   options.title    - Modal heading (plain text)
 * @param {string}   options.content  - Body HTML string (sanitise before passing)
 * @param {Array}    [options.actions]  - Button descriptors { label, variant, onClick }
 * @param {boolean}  [options.showClose] - Show ✕ close button (default true)
 * @param {Function} [options.onClose]   - Called after the modal closes
 */
export function openModal({ title, content, actions = [], showClose = true, onClose } = {}) {
    _injectStyles();

    // Close any existing modal first
    if (_overlay) closeModal();

    // Remember what had focus so we can return it on close
    _triggerEl = document.activeElement;

    // ── Build overlay ─────────────────────────────────────────────────────────
    _overlay = document.createElement('div');
    _overlay.id            = 'hh-modal-overlay';
    _overlay.setAttribute('role', 'presentation');

    // Clicking the backdrop closes the modal
    _overlay.addEventListener('click', (e) => {
        if (e.target === _overlay) closeModal();
    });

    // ── Build dialog ──────────────────────────────────────────────────────────
    const dialog = document.createElement('div');
    dialog.id                    = 'hh-modal-dialog';
    dialog.setAttribute('role',       'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'hh-modal-title');

    // Title
    const titleEl   = document.createElement('h2');
    titleEl.id          = 'hh-modal-title';
    titleEl.textContent = title || '';

    // Body
    const bodyEl    = document.createElement('div');
    bodyEl.id           = 'hh-modal-body';
    bodyEl.innerHTML    = content || '';

    // Actions
    const actionsEl = document.createElement('div');
    actionsEl.id        = 'hh-modal-actions';

    for (const action of actions) {
        const btn = document.createElement('button');
        btn.type        = 'button';
        btn.className   = `hh-modal-btn ${action.variant || 'secondary'}`;
        btn.textContent = action.label || '';
        btn.addEventListener('click', () => {
            if (typeof action.onClick === 'function') action.onClick();
        });
        actionsEl.appendChild(btn);
    }

    // Optional ✕ close button
    if (showClose) {
        const closeBtn = document.createElement('button');
        closeBtn.id          = 'hh-modal-close-btn';
        closeBtn.type        = 'button';
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', 'Close dialog');
        closeBtn.addEventListener('click', closeModal);
        dialog.appendChild(closeBtn);
    }

    // Assemble
    dialog.appendChild(titleEl);
    dialog.appendChild(bodyEl);
    if (actions.length > 0) dialog.appendChild(actionsEl);
    _overlay.appendChild(dialog);
    document.body.appendChild(_overlay);

    // ── Lock scroll & trap focus ──────────────────────────────────────────────
    document.body.style.overflow = 'hidden';

    _keydownHandler = _trapFocus;
    document.addEventListener('keydown', _keydownHandler);

    // Store onClose callback so closeModal can invoke it
    _overlay._onClose = onClose;

    // Focus the first interactive element (or the dialog itself as fallback)
    const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE));
    if (focusable.length > 0) {
        focusable[0].focus();
    } else {
        dialog.setAttribute('tabindex', '-1');
        dialog.focus();
    }
}

/**
 * Programmatically close the currently open modal.
 */
export function closeModal() {
    if (!_overlay) return;

    if (_keydownHandler) {
        document.removeEventListener('keydown', _keydownHandler);
        _keydownHandler = null;
    }

    const onClose = _overlay._onClose;

    _overlay.remove();
    _overlay = null;

    document.body.style.overflow = '';

    // Return focus to the element that opened the modal
    if (_triggerEl && typeof _triggerEl.focus === 'function') {
        try { _triggerEl.focus(); } catch (_) {}
    }
    _triggerEl = null;

    if (typeof onClose === 'function') onClose();
}
