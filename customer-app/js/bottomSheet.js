/**
 * HandyHub Bottom Sheet Engine v1.0
 *
 * Physics-based, keyboard-aware, velocity-sensitive gesture system.
 * Drop-in for any hero+card page layout.
 *
 * Usage:
 *   import { initBottomSheet } from './bottomSheet.js';
 *   const sheet = initBottomSheet({ card, handle, inputs });
 *   sheet.expand();   // snap to FULL
 *   sheet.collapse(); // snap to COLLAPSED
 */

/* ─── Spring curves ──────────────────────────────────────────────────────── */
const SP_SETTLE = 'cubic-bezier(0.22, 1, 0.36, 1)';       // smooth settle
const SP_SNAP   = 'cubic-bezier(0.34, 1.28, 0.64, 1)';    // slight overshoot on velocity-snap
const SP_FAST   = 'cubic-bezier(0.25, 1, 0.5, 1)';        // quick collapse

/* ─── Snap fractions (fraction of visual-viewport height that is visible) ── */
const S = {
  COLLAPSED : 0.62,   // default → 62 % of vh visible
  MID       : 0.80,   // mid expanded
  FULL      : 0.94,   // near full screen
  CARD      : 0.95,   // physical card height
};

/* ─── Velocity thresholds (px / ms) ─────────────────────────────────────── */
const VEL_DOWN = 0.35;   // fast swipe-down → collapse
const VEL_UP   = 0.30;   // fast swipe-up   → expand

/* ════════════════════════════════════════════════════════════════════════════
   initBottomSheet
   ════════════════════════════════════════════════════════════════════════════ */
export function initBottomSheet({ card, handle, inputs = [] }) {

  /* ── State ─────────────────────────────────────────────────────────────── */
  let snap      = S.COLLAPSED;   // current snap fraction
  let kbH       = 0;             // keyboard height in px
  let dragging  = false;
  let startY    = 0;
  let startOff  = 0;             // translateY at drag start
  let lastY     = 0;
  let lastT     = 0;
  let vel       = 0;             // px / ms, positive = downward

  /* ── Helper: viewport height (visual — excludes keyboard) ──────────────── */
  const winH = () => window.innerHeight;
  const vvH  = () => (window.visualViewport ? window.visualViewport.height : winH());

  /* Card physical height in px */
  const cardPx = () => winH() * S.CARD;

  /* translateY so that `fraction` of visual-viewport is visible from bottom */
  function offsetFor(fraction) {
    const visible = fraction * vvH();
    return Math.max(0, cardPx() - visible);
  }

  /* Backdrop opacity for a given snap fraction */
  function dimFor(fraction) {
    const t = (fraction - S.COLLAPSED) / (S.FULL - S.COLLAPSED);
    return Math.max(0, Math.min(0.30, t * 0.30));
  }

  /* ── Apply fixed-position card styles ──────────────────────────────────── */
  Object.assign(card.style, {
    position       : 'fixed',
    left           : '0',
    right          : '0',
    bottom         : '0',
    width          : '100%',
    maxWidth       : '430px',
    marginLeft     : 'auto',
    marginRight    : 'auto',
    height         : `${S.CARD * 100}dvh`,
    borderRadius   : '32px 32px 0 0',
    overflowY      : 'auto',
    overscrollBehavior: 'contain',
    willChange     : 'transform',
    zIndex         : '500',
    flex           : 'none',
    marginTop      : '0',
    animation      : 'none',     // suppress CSS card-in animation
    paddingBottom  : 'max(24px, env(safe-area-inset-bottom))',
  });

  /* Touch-action only on the handle so card content stays scrollable */
  if (handle) handle.style.touchAction = 'none';

  /* ── Backdrop ───────────────────────────────────────────────────────────── */
  const bd = document.createElement('div');
  Object.assign(bd.style, {
    position       : 'fixed',
    inset          : '0',
    zIndex         : '499',
    background     : 'transparent',
    transition     : 'background 0.32s ease',
    pointerEvents  : 'none',
    WebkitBackdropFilter: 'blur(0px)',
    backdropFilter : 'blur(0px)',
  });
  document.body.appendChild(bd);

  /* ── Core animation ─────────────────────────────────────────────────────── */
  function applyTransform(offset, { animate = true, fast = false, settle = false } = {}) {
    let dur  = '0.46s';
    let ease = SP_SETTLE;
    if (!animate)  { dur = '0s';    ease = 'none'; }
    else if (fast) { dur = '0.28s'; ease = SP_SNAP; }
    else if (settle){ dur = '0.38s'; ease = SP_FAST; }

    card.style.transition = animate
      ? `transform ${dur} ${ease}, bottom 0.22s ease`
      : 'none';
    card.style.transform  = `translateY(${Math.round(offset)}px)`;
  }

  function goTo(fraction, opts = {}) {
    snap = Math.max(S.COLLAPSED * 0.75, Math.min(S.FULL, fraction));
    applyTransform(offsetFor(snap), opts);
    bd.style.background   = `rgba(0,0,0,${dimFor(snap).toFixed(3)})`;
    bd.style.pointerEvents = snap > S.COLLAPSED ? 'auto' : 'none';
  }

  /* ── Entrance animation ─────────────────────────────────────────────────── */
  // Start off-screen below, spring up to collapsed position
  card.style.transition = 'none';
  card.style.transform  = `translateY(${winH()}px)`;   // fully hidden below

  setTimeout(() => {
    card.style.transition = `transform 0.62s ${SP_SETTLE} 0.05s`;
    card.style.transform  = `translateY(${Math.round(offsetFor(S.COLLAPSED))}px)`;
    bd.style.background   = 'rgba(0,0,0,0)';
    snap = S.COLLAPSED;

    // Subtle handle pulse after entrance to hint it's draggable
    if (handle) {
      setTimeout(() => {
        handle.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        handle.style.transform  = 'scaleX(1.35)';
        handle.style.opacity    = '0.8';
        setTimeout(() => {
          handle.style.transform = 'scaleX(1)';
          handle.style.opacity   = '';
          setTimeout(() => {
            handle.style.transition = '';
            handle.style.transform  = '';
          }, 320);
        }, 320);
      }, 800);
    }
  }, 60);

  /* ── Keyboard detection via visualViewport ──────────────────────────────── */
  if (window.visualViewport) {
    const onVVResize = () => {
      const wH  = winH();
      const vvh = vvH();
      kbH = Math.max(0, wH - vvh);

      if (kbH > 80) {
        // Keyboard open — move card bottom to top of keyboard
        card.style.transition = `transform 0.36s ${SP_SETTLE}, bottom 0.22s ease`;
        card.style.bottom = kbH + 'px';
        // Ensure we're fully expanded (recalculate with new vvH)
        if (snap < S.FULL) goTo(S.FULL);
        else applyTransform(offsetFor(S.FULL));     // recalc offset with smaller vvH
      } else {
        // Keyboard closed
        card.style.transition = `transform 0.42s ${SP_SETTLE}, bottom 0.28s ease`;
        card.style.bottom = '0';
        applyTransform(offsetFor(snap));            // recalc offset with full vvH
      }
    };
    window.visualViewport.addEventListener('resize', onVVResize);
    window.visualViewport.addEventListener('scroll', onVVResize);
  }

  /* ── Input focus → auto-expand ──────────────────────────────────────────── */
  inputs.forEach(inp => {
    inp.addEventListener('focus', () => {
      goTo(S.FULL);
      // After keyboard settles, scroll focused input into view
      setTimeout(() => inp.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 460);
    }, { passive: true });

    inp.addEventListener('blur', () => {
      // Collapse only if no other input in the card is active and keyboard is gone
      setTimeout(() => {
        if (kbH < 80 && !card.contains(document.activeElement)) {
          goTo(S.COLLAPSED, { settle: true });
        }
      }, 360);
    }, { passive: true });
  });

  /* ── Drag gestures ──────────────────────────────────────────────────────── */
  function clientY(e) {
    return e.touches ? e.touches[0].clientY : e.clientY;
  }

  /** Read live translateY from computed matrix (works mid-animation) */
  function readOffset() {
    const t = new DOMMatrix(getComputedStyle(card).transform);
    return t.m42;    // translateY component
  }

  /** Decide if a pointer event is in the draggable zone */
  function inDragZone(e) {
    const target = e.target;
    // Never start drag on interactive elements
    if (target.closest('button, input, a, select, textarea, label, [role="button"]')) return false;
    // Always drag from the explicit handle
    if (handle && (handle === target || handle.contains(target))) return true;
    // Also allow drag from the first 72 px of the card
    const rect = card.getBoundingClientRect();
    return (clientY(e) - rect.top) < 72;
  }

  function onStart(e) {
    if (!inDragZone(e)) return;
    dragging  = true;
    startY    = clientY(e);
    startOff  = readOffset();
    lastY     = startY;
    lastT     = Date.now();
    vel       = 0;

    card.style.transition = 'none';
    card.classList.add('bs-dragging');
    if (e.cancelable) e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;

    const y   = clientY(e);
    const now = Date.now();
    vel       = (y - lastY) / Math.max(1, now - lastT);
    lastY     = y;
    lastT     = now;

    const dy   = y - startY;
    let offset = startOff + dy;

    /* Rubber-band resistance at extremes */
    const minOff = offsetFor(S.FULL)       - 14;
    const maxOff = offsetFor(S.COLLAPSED)  + 90;

    if      (offset < minOff) offset = minOff + (offset - minOff) * 0.18;
    else if (offset > maxOff) offset = maxOff + (offset - maxOff) * 0.22;

    card.style.transform = `translateY(${Math.round(offset)}px)`;

    /* Live backdrop dim */
    const visFraction = (cardPx() - offset) / vvH();
    bd.style.background = `rgba(0,0,0,${dimFor(Math.max(0, Math.min(1, visFraction))).toFixed(3)})`;

    if (e.cancelable) e.preventDefault();
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('bs-dragging');

    /* Current visible fraction at release */
    const offset     = readOffset();
    const visFraction = (cardPx() - offset) / vvH();

    /* Velocity-aware snap selection */
    let target;
    if      (vel > VEL_DOWN) target = kbH > 80 ? S.MID : S.COLLAPSED;
    else if (vel < -VEL_UP)  target = S.FULL;
    else {
      const candidates = kbH > 80
        ? [S.MID, S.FULL]
        : [S.COLLAPSED, S.MID, S.FULL];
      target = candidates.reduce((best, s) =>
        Math.abs(s - visFraction) < Math.abs(best - visFraction) ? s : best
      );
    }

    goTo(target, { animate: true, fast: true });
  }

  /* Touch events */
  card.addEventListener('touchstart',  onStart, { passive: false });
  card.addEventListener('touchmove',   onMove,  { passive: false });
  card.addEventListener('touchend',    onEnd,   { passive: true });
  card.addEventListener('touchcancel', onEnd,   { passive: true });

  /* Mouse events (desktop preview / dev) */
  card.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onEnd);

  /* ── Backdrop tap → collapse ────────────────────────────────────────────── */
  bd.addEventListener('click', () => {
    if (kbH < 80) goTo(S.COLLAPSED, { settle: true });
  });

  // Tap anywhere outside card on hero area → collapse
  document.addEventListener('touchend', (e) => {
    if (!card.contains(e.target) && !bd.contains(e.target) && kbH < 80) {
      if (snap > S.COLLAPSED) goTo(S.COLLAPSED, { settle: true });
    }
  }, { passive: true });

  /* ── Public API ─────────────────────────────────────────────────────────── */
  return {
    expand   : ()  => goTo(S.FULL,      { animate: true }),
    collapse : ()  => goTo(S.COLLAPSED, { settle: true }),
    mid      : ()  => goTo(S.MID,       { animate: true }),
    getSnap  : ()  => snap,
  };
}
