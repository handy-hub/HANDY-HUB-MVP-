/**
 * attachSwipeDismiss — universal swipe-to-close gesture for bottom sheets
 *
 * Handles: real-time drag tracking, velocity-based fast-dismiss, elastic
 * upward resistance, overlay fade proportional to drag, scroll conflict
 * detection (only steals the gesture when content is scrolled to the top),
 * and spring snap-back when the user cancels.
 *
 * Preserves any translateX centering (e.g. translateX(-50%)) that a sheet
 * uses for its positioning — reads it once at touchstart and reapplies it.
 *
 * @param {HTMLElement} overlayEl  The backdrop / overlay element
 * @param {HTMLElement} sheetEl    The bottom sheet to drag (transform target)
 * @param {Function}    closeFn    Called after the exit animation completes
 * @param {object}      [opts]
 *   threshold  {number}  Fraction of sheet height that triggers dismiss (0.38)
 *   velThresh  {number}  Velocity in px/ms that triggers fast-dismiss (0.45)
 *   handleSel  {string}  CSS selector for drag handle within the sheet
 */
export function attachSwipeDismiss(overlayEl, sheetEl, closeFn, {
  threshold = 0.38,
  velThresh = 0.45,
  handleSel = '[class$="-handle"]',
} = {}) {
  const EASE_CLOSE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const EASE_SNAP  = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

  // state machine: idle → undecided → dismiss | scroll
  let state = 'idle';
  let startY = 0, lastY = 0, lastT = 0, vel = 0;
  // resolved pixel translations captured at touchstart (preserves translateX)
  let originXpx = 0, originYpx = 0;
  let fromHandle = false;
  let scrollable = null;

  function readTranslatePx() {
    const t = getComputedStyle(sheetEl).transform;
    if (!t || t === 'none') return { x: 0, y: 0 };
    const m = new DOMMatrix(t);
    return { x: m.m41, y: m.m42 };
  }

  function applyTransform(yPx) {
    // Compose with captured originXpx so CSS centering tricks (translateX(-50%))
    // are preserved during and after the drag.
    sheetEl.style.transform = originXpx !== 0
      ? `translateX(${originXpx}px) translateY(${yPx}px)`
      : `translateY(${yPx}px)`;
  }

  function findScrollable(startEl) {
    let el = startEl;
    while (el && el !== sheetEl) {
      if (el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return sheetEl.scrollHeight > sheetEl.clientHeight + 4 ? sheetEl : null;
  }

  function onTouchStart(e) {
    if (state !== 'idle') return;
    const touch = e.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY) || e.target;
    scrollable = findScrollable(target);

    const handle = sheetEl.querySelector(handleSel);
    const rect   = sheetEl.getBoundingClientRect();
    fromHandle   = (handle && (handle === target || handle.contains(target)))
                || (touch.clientY - rect.top) < 60;

    const { x, y } = readTranslatePx();
    originXpx = x;
    originYpx = y;

    state  = 'undecided';
    startY = lastY = touch.clientY;
    lastT  = Date.now();
    vel    = 0;
  }

  function onTouchMove(e) {
    if (state === 'idle' || state === 'scroll') return;

    const touch = e.touches[0];
    const now   = Date.now();
    const dy    = touch.clientY - startY;
    vel    = (touch.clientY - lastY) / Math.max(1, now - lastT);
    lastY  = touch.clientY;
    lastT  = now;

    if (state === 'undecided') {
      if (Math.abs(dy) < 6) return;
      if (fromHandle) {
        state = 'dismiss';
      } else if (dy > 0) {
        // downward — only steal if the scrollable content has nothing above
        state = (!scrollable || scrollable.scrollTop <= 0) ? 'dismiss' : 'scroll';
      } else {
        state = 'scroll';
      }
    }

    if (state !== 'dismiss') return;
    e.preventDefault(); // stop native scroll once classified as dismiss

    // Rubber-band resistance when pulling above the origin (dy < 0)
    const rawY = originYpx + dy;
    const yPx  = dy < 0 ? originYpx + dy * 0.12 : rawY;

    sheetEl.style.transition  = 'none';
    applyTransform(Math.round(yPx));

    // Fade overlay proportional to drag toward the dismiss threshold
    const dismissPx = sheetEl.offsetHeight * threshold;
    const progress  = Math.max(0, Math.min(1, (yPx - originYpx) / dismissPx));
    overlayEl.style.transition = 'none';
    overlayEl.style.opacity    = (1 - progress * 0.85).toFixed(3);
  }

  function onTouchEnd() {
    if (state !== 'dismiss') { state = 'idle'; return; }

    const { y: currentYpx } = readTranslatePx();
    const dragDist  = currentYpx - originYpx;
    const dismissPx = sheetEl.offsetHeight * threshold;

    if (dragDist > dismissPx || vel > velThresh) {
      // ── Exit: fly off-screen, then call closeFn ──
      const exitY = sheetEl.offsetHeight + 40;
      sheetEl.style.transition  = `transform 0.30s ${EASE_CLOSE}`;
      applyTransform(exitY);
      overlayEl.style.transition = 'opacity 0.28s ease';
      overlayEl.style.opacity    = '0';

      setTimeout(() => {
        closeFn();
        // Sheet can be cleaned up immediately — it's already off-screen
        requestAnimationFrame(() => {
          sheetEl.style.transition = '';
          sheetEl.style.transform  = '';
        });
        // Delay overlay cleanup so any CSS background transition triggered by
        // closeFn (e.g. background .3s on #pmo-overlay) has time to finish
        // before we restore opacity, preventing a dark-flash artifact.
        setTimeout(() => {
          overlayEl.style.transition = '';
          overlayEl.style.opacity   = '';
        }, 380);
      }, 310);
    } else {
      // ── Snap back with spring ──
      sheetEl.style.transition  = `transform 0.42s ${EASE_SNAP}`;
      applyTransform(originYpx);
      overlayEl.style.transition = 'opacity 0.32s ease';
      overlayEl.style.opacity    = '1';

      // Clear inline styles after spring completes (safety timeout as fallback)
      const clear = () => {
        sheetEl.style.transition = '';
        sheetEl.style.transform  = '';
        overlayEl.style.transition = '';
      };
      const timer = setTimeout(clear, 480);
      sheetEl.addEventListener('transitionend', () => { clearTimeout(timer); clear(); },
        { once: true });
    }

    state = 'idle';
  }

  sheetEl.addEventListener('touchstart',  onTouchStart, { passive: true  });
  sheetEl.addEventListener('touchmove',   onTouchMove,  { passive: false });
  sheetEl.addEventListener('touchend',    onTouchEnd,   { passive: true  });
  sheetEl.addEventListener('touchcancel', onTouchEnd,   { passive: true  });
}
