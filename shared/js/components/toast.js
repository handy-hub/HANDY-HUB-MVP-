/**
 * HandyHub Toast v2
 * - Stacked queue, top-centre on mobile / top-right on desktop
 * - Swipe-up to dismiss (touch + mouse drag)
 * - Timer pauses on interaction, resumes on release
 * - Self-injects CSS, no external stylesheet needed
 * - Exports: showToast(message, type, options)
 * - Also sets window.showToast for non-module callers
 */

/* ── CSS ─────────────────────────────────────────────────────────── */
const CSS = `
@keyframes _ht-in {
  from { opacity:0; transform:translateY(-14px) scale(0.93); }
  to   { opacity:1; transform:translateY(0)     scale(1);    }
}
@keyframes _ht-out {
  to   { opacity:0; transform:translateY(-24px) scale(0.90); }
}

#hh-toast-root {
  position: fixed;
  top: max(16px, env(safe-area-inset-top, 0px) + 12px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 11000;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: min(92vw, 400px);
  pointer-events: none;
}

@media (min-width: 640px) {
  #hh-toast-root {
    left: auto;
    right: 24px;
    transform: none;
  }
}

.hh-toast {
  pointer-events: all;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 16px 11px 11px;
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08), 0 4px 20px rgba(0,0,0,0.07);
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: #111;
  line-height: 1.4;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  will-change: transform, opacity;
  animation: _ht-in 0.40s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

.hh-toast._ht-exit {
  pointer-events: none;
  animation: _ht-out 0.26s cubic-bezier(0.32, 0.72, 0, 1) forwards;
}

.hh-toast-icon {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.hh-toast-icon svg {
  width: 15px;
  height: 15px;
  display: block;
}

.hh-toast.success .hh-toast-icon { background:#e8f7ed; color:#1c8a3f; }
.hh-toast.error   .hh-toast-icon { background:#fde9e9; color:#c0392b; }
.hh-toast.info    .hh-toast-icon { background:#e8f3fd; color:#1a6fc4; }

.hh-toast-msg {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

@media (prefers-color-scheme: dark) {
  .hh-toast {
    background: #1c1c1e;
    border-color: rgba(255,255,255,0.09);
    color: #f0f0f0;
    box-shadow: 0 4px 24px rgba(0,0,0,0.50);
  }
  .hh-toast.success .hh-toast-icon { background:rgba(28,138,63,0.18);  color:#4cd07d; }
  .hh-toast.error   .hh-toast-icon { background:rgba(192,57,43,0.18);  color:#ff6b6b; }
  .hh-toast.info    .hh-toast-icon { background:rgba(26,111,196,0.18); color:#5aabff; }
}

@media (prefers-reduced-motion: reduce) {
  .hh-toast, .hh-toast._ht-exit { animation: none !important; }
}
`;

/* ── Icons ───────────────────────────────────────────────────────── */
const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7L10.25 16.75L6 12.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error:   '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1" fill="currentColor"/><path d="M10.29 3.86L1.82 18A2 2 0 003.53 21h16.94A2 2 0 0022.18 18L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 10v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1" fill="currentColor"/></svg>',
};

/* ── State ───────────────────────────────────────────────────────── */
const DEFAULT_MS = 3000;
const ANIM_OUT   = 280;

let _root = null;
const _queue = [];

/* ── Bootstrap ───────────────────────────────────────────────────── */
function _ensureRoot() {
  if (_root) return _root;

  if (!document.getElementById('_ht-styles')) {
    const s = document.createElement('style');
    s.id = '_ht-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  _root = document.createElement('div');
  _root.id = 'hh-toast-root';
  _root.setAttribute('aria-live', 'polite');
  _root.setAttribute('aria-atomic', 'false');
  document.body.appendChild(_root);
  return _root;
}

/* ── Timer helpers ───────────────────────────────────────────────── */
function _startTimer(entry) {
  entry.startedAt = Date.now();
  entry.timer = setTimeout(() => _dismiss(entry), entry.remaining);
}

function _pauseTimer(entry) {
  if (!entry.startedAt) return;
  clearTimeout(entry.timer);
  entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  entry.startedAt = null;
}

/* ── Dismiss ─────────────────────────────────────────────────────── */
function _dismiss(entry) {
  if (entry.gone) return;
  entry.gone = true;
  clearTimeout(entry.timer);

  const el = entry.el;
  el.classList.add('_ht-exit');

  const done = () => {
    el.remove();
    const i = _queue.indexOf(entry);
    if (i !== -1) _queue.splice(i, 1);
  };

  el.addEventListener('animationend', done, { once: true });
  setTimeout(done, ANIM_OUT + 50); // safety fallback
}

/* ── Gesture wiring ──────────────────────────────────────────────── */
function _wire(entry) {
  const el = entry.el;
  let active = false;
  let startY = 0, lastY = 0, lastT = 0, vel = 0;

  function start(clientY) {
    active   = true;
    startY   = lastY = clientY;
    lastT    = Date.now();
    vel      = 0;
    el.style.transition = 'none';
    _pauseTimer(entry);
  }

  function move(clientY) {
    if (!active) return;
    const now = Date.now();
    const dt  = Math.max(1, now - lastT);
    vel   = (clientY - lastY) / dt;
    lastY = clientY;
    lastT = now;

    const dy = clientY - startY; // negative = upward

    if (dy > 0) {
      // downward — rubber-band resistance
      el.style.transform = `translateY(${(dy * 0.12).toFixed(1)}px)`;
      el.style.opacity   = '1';
    } else {
      el.style.transform = `translateY(${dy.toFixed(1)}px)`;
      // fade out as it moves up
      const progress = Math.min(1, Math.abs(dy) / (el.offsetHeight * 1.2));
      el.style.opacity = (1 - progress * 0.7).toFixed(3);
    }
  }

  function end() {
    if (!active) return;
    active = false;

    const dy = lastY - startY; // negative = moved up
    const shouldDismiss = dy < -44 || vel < -0.38;

    if (shouldDismiss) {
      // fly off the top
      el.style.transition = `transform 0.26s cubic-bezier(0.32,0.72,0,1),
                              opacity   0.22s ease`;
      el.style.transform  = `translateY(-${el.offsetHeight + 24}px)`;
      el.style.opacity    = '0';
      setTimeout(() => _dismiss(entry), 0);
    } else {
      // spring back
      el.style.transition = `transform 0.42s cubic-bezier(0.34,1.56,0.64,1),
                              opacity   0.28s ease`;
      el.style.transform  = '';
      el.style.opacity    = '';
      el.addEventListener('transitionend', () => {
        if (!entry.gone) el.style.transition = '';
      }, { once: true });
      _startTimer(entry); // resume countdown
    }
  }

  // ── Touch ──────────────────────────────────────────────────────
  el.addEventListener('touchstart',  e => start(e.touches[0].clientY),  { passive: true  });
  el.addEventListener('touchmove',   e => { e.preventDefault(); move(e.touches[0].clientY); }, { passive: false });
  el.addEventListener('touchend',    end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });

  // ── Mouse (desktop drag-up) ────────────────────────────────────
  el.addEventListener('mousedown', e => { e.preventDefault(); start(e.clientY); });

  const onMouseMove = e => move(e.clientY);
  const onMouseUp   = ()  => { if (active) { end(); } document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };

  el.addEventListener('mousedown', () => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  });
}

/* ── Build DOM ───────────────────────────────────────────────────── */
function _buildEl(message, type) {
  const el = document.createElement('div');
  el.className = `hh-toast ${type}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-atomic', 'true');

  const iconWrap = document.createElement('span');
  iconWrap.className = 'hh-toast-icon';
  iconWrap.setAttribute('aria-hidden', 'true');
  iconWrap.innerHTML = ICONS[type] || ICONS.info;

  const msg = document.createElement('span');
  msg.className = 'hh-toast-msg';
  msg.textContent = String(message || '');

  el.append(iconWrap, msg);
  return el;
}

/* ── Public API ──────────────────────────────────────────────────── */
export function showToast(message, typeOrOptions = 'info', options = {}) {
  // Resolve config
  let type, dismissMs;
  if (typeof typeOrOptions === 'object' && typeOrOptions !== null) {
    type      = typeOrOptions.type      || 'info';
    dismissMs = typeOrOptions.dismissMs || DEFAULT_MS;
  } else {
    type      = typeOrOptions || 'info';
    dismissMs = (options && options.dismissMs) ? options.dismissMs : DEFAULT_MS;
  }
  if (!ICONS[type]) type = 'info';

  const root = _ensureRoot();
  const el   = _buildEl(message, type);
  root.appendChild(el);

  const entry = {
    el,
    timer:     null,
    remaining: dismissMs,
    startedAt: null,
    gone:      false,
  };

  _queue.push(entry);
  _startTimer(entry);
  _wire(entry);

  return { dismiss: () => _dismiss(entry) };
}

// Expose for non-module pages (inline scripts, dashboard.html, etc.)
if (typeof window !== 'undefined') {
  window.showToast = showToast;
}
