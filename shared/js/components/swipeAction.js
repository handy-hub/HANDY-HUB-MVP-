/**
 * swipeAction.js
 *
 * Canonical swipe-left-to-reveal-action gesture, extracted from the
 * Notification page (the first, validated implementation of this pattern in
 * the product). Any list of dismissible/actionable row cards — notifications,
 * cancellable bookings, saved items — wires into this instead of re-deriving
 * its own touch-tracking, threshold, and reveal-animation logic.
 *
 * Markup contract (per row):
 *   <div class="swipe-row">
 *     <div class="swipe-action" aria-hidden="true"> ...icon + label... </div>
 *     <div class="swipe-card" data-id="...">        ...row content...     </div>
 *   </div>
 *
 * `.swipe-row` / `.swipe-action` / `.swipe-card` carry only structural CSS
 * (shared/css/components/swipeAction.css). Pages may add their own modifier
 * classes to `.swipe-card` (e.g. `notif-card`, `bk-card`) for content styling.
 */

const DELETE_THRESHOLD = 72;
const MAX_DRAG         = 90;

/**
 * Wire swipe-to-reveal gestures onto every `.swipe-row` inside `listEl`.
 *
 * @param {HTMLElement} listEl
 * @param {object}      opts
 * @param {(id: string) => void} opts.onCommit
 *        Called once the user swipes past the threshold and releases —
 *        after the row's collapse animation finishes. Receives the row's
 *        `data-id`. Callers own what "commit" means (delete a notification,
 *        cancel a booking, remove a saved item).
 * @param {(dx: number) => void} [opts.onSwipeStart]
 *        Optional — called on the first real horizontal movement of a row,
 *        useful for suppressing a simultaneous tap-to-open handler.
 * @returns {() => number} a function returning the timestamp of the last
 *        real swipe, so callers can debounce a click handler that fires on
 *        the same touch sequence (see notificationPage.js's `_lastSwipeTime`
 *        pattern) without each page re-implementing the same 300ms guard.
 */
export function wireSwipeAction(listEl, { onCommit, onSwipeStart } = {}) {
    let lastSwipeTime = 0;

    listEl.querySelectorAll('.swipe-row').forEach(row => {
        const card   = row.querySelector('.swipe-card');
        const action = row.querySelector('.swipe-action');
        if (!card) return;

        const id = card.dataset.id;
        let startX = 0, startY = 0, currentDx = 0;
        let tracking = false, didRealSwipe = false, direction = null;

        function cancelGesture() { tracking = false; direction = null; }

        function onTouchStart(e) {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentDx = 0; tracking = true; didRealSwipe = false; direction = null;
            card.style.transition = 'none';
        }

        function onTouchMove(e) {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;

            if (direction === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                direction = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
            }
            if (direction === 'v') { cancelGesture(); return; }

            if (direction === 'h' && dx < 0) {
                e.preventDefault();
                if (!didRealSwipe) onSwipeStart?.(dx);
                didRealSwipe = true;
                currentDx = Math.max(dx, -(MAX_DRAG + 22));
                card.style.transform = `translateX(${currentDx}px)`;
                if (action) {
                    const ratio = Math.min(Math.abs(currentDx) / DELETE_THRESHOLD, 1.3);
                    action.style.transform = `scale(${(0.85 + ratio * 0.25).toFixed(3)})`;
                    action.classList.toggle('swipe-action--armed', currentDx < -DELETE_THRESHOLD);
                }
            }
        }

        function onTouchEnd() {
            if (!tracking) return;
            tracking = false;
            if (didRealSwipe) lastSwipeTime = Date.now();

            if (currentDx < -DELETE_THRESHOLD) {
                if (navigator.vibrate) navigator.vibrate(12);
                card.style.transition = 'transform 0.22s ease-in';
                card.style.transform  = 'translateX(-110%)';
                setTimeout(() => {
                    const h = row.offsetHeight;
                    row.style.height = h + 'px';
                    void row.offsetHeight;
                    row.style.transition = 'height 0.26s ease, opacity 0.18s ease';
                    row.style.overflow   = 'hidden';
                    row.style.opacity    = '0';
                    row.style.height     = '0';
                    setTimeout(() => {
                        if (row.parentNode) row.remove();
                        onCommit?.(id);
                    }, 270);
                }, 210);
            } else {
                card.style.transition = 'transform 0.42s cubic-bezier(0.34,1.56,0.64,1)';
                card.style.transform  = 'translateX(0)';
                if (action) {
                    action.style.transition = 'transform 0.42s cubic-bezier(0.34,1.56,0.64,1)';
                    action.style.transform  = '';
                    action.classList.remove('swipe-action--armed');
                }
                setTimeout(() => {
                    card.style.transition = '';
                    card.style.transform  = '';
                    if (action) action.style.transition = '';
                }, 450);
            }
        }

        card.addEventListener('touchstart',  onTouchStart,  { passive: true  });
        card.addEventListener('touchmove',   onTouchMove,   { passive: false });
        card.addEventListener('touchend',    onTouchEnd);
        card.addEventListener('touchcancel', onTouchEnd);
    });

    return () => lastSwipeTime;
}

/**
 * Canonical "optimistic action + Undo" toast, extracted from the Notification
 * page's UndoToast. One instance holds at most one pending action at a time —
 * if a second commit request arrives while a toast is showing, the first is
 * committed immediately before the new toast appears.
 *
 * @param {object} opts
 * @param {string} [opts.message]   Toast body text. Default: "Removed".
 * @param {string} [opts.icon]      Font Awesome class for the leading icon.
 * @param {number} [opts.durationMs] Undo window length. Default 6000.
 */
export function createUndoToast({ message = 'Removed', icon = 'fa-solid fa-trash-can', durationMs = 6000 } = {}) {
    let pending = null; // { id, payload, onCommit }
    let timer   = null;
    let hostEl  = null;
    let toastEl = null;

    function ensureHost() {
        if (hostEl && hostEl.isConnected) return;
        hostEl = document.createElement('div');
        hostEl.className = 'undo-toast-host';
        hostEl.setAttribute('aria-live', 'polite');
        hostEl.setAttribute('aria-atomic', 'true');
        document.body.appendChild(hostEl);
    }

    function clearTimer() {
        if (timer !== null) { clearTimeout(timer); timer = null; }
    }

    function commitPending() {
        if (!pending) return;
        const { id, onCommit } = pending;
        pending = null;
        onCommit?.(id);
    }

    function hide(onDone) {
        if (!toastEl) { onDone?.(); return; }
        toastEl.classList.remove('is-visible');
        toastEl.classList.add('is-hiding');
        const el = toastEl;
        setTimeout(() => {
            if (el.parentNode) el.parentNode.innerHTML = '';
            toastEl = null;
            onDone?.();
        }, 340);
    }

    /**
     * Show the undo toast for a just-committed (optimistically removed) row.
     *
     * @param {string}   id        Identifier passed back to onCommit/onUndo
     * @param {object}   payload   Arbitrary data the caller needs to restore state
     * @param {(id: string) => void} onCommit  Called when the undo window expires
     * @param {(payload: object) => void} onUndo Called if the user taps Undo
     */
    function show(id, payload, onCommit, onUndo) {
        ensureHost();

        if (pending) { clearTimer(); commitPending(); }

        pending = { id, payload, onCommit };

        hostEl.innerHTML = `
            <div class="undo-toast" role="status" aria-label="${message}. Tap Undo to restore.">
                <div class="undo-toast__icon" aria-hidden="true"><i class="${icon}"></i></div>
                <span class="undo-toast__msg">${message}</span>
                <button class="undo-toast__undo" type="button" aria-label="Undo">Undo</button>
                <div class="undo-toast__progress" aria-hidden="true">
                    <div class="undo-toast__progress-fill" style="--toast-duration: ${durationMs}ms"></div>
                </div>
            </div>`;

        toastEl = hostEl.querySelector('.undo-toast');

        hostEl.querySelector('.undo-toast__undo').addEventListener('click', () => {
            clearTimer();
            const restore = pending;
            pending = null;
            hide(() => onUndo?.(restore?.payload));
        });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => { if (toastEl) toastEl.classList.add('is-visible'); });
        });

        timer = setTimeout(() => {
            timer = null;
            const toCommit = pending;
            pending = null;
            hide(() => { if (toCommit) toCommit.onCommit?.(toCommit.id); });
        }, durationMs);
    }

    /** Commit any pending action synchronously — call this on pagehide. */
    function commitAll() {
        clearTimer();
        if (!pending) return;
        const { id, onCommit } = pending;
        pending = null;
        onCommit?.(id);
    }

    /** Whether `id` currently has a commit deferred behind an open undo window. */
    function isPending(id) {
        return !!pending && pending.id === id;
    }

    return { show, commitAll, isPending };
}
