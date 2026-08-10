/**
 * artisanDevBadge.js — the on-screen "Development Mode" badge + state switcher.
 *
 * Mounted ONLY by artisanAuthGuard when Artisan Development Access Mode is active.
 * It never renders in production (the guard never calls it there). It sits above
 * the auth overlay (z-index beats 99999) so the developer can always switch state,
 * even on a state whose gate blocks the page (suspended / data-error).
 *
 * Switching a state persists it (artisanDevSession) and reloads, so the guard
 * re-resolves the new state cleanly — the same way a real auth change would.
 */

import { listDevStates, getDevStateKey, setDevStateKey } from './artisanDevSession.js';

const BADGE_ID = 'hh-dev-badge';

function injectStyles() {
    if (document.getElementById('hh-dev-badge-styles')) return;
    const s = document.createElement('style');
    s.id = 'hh-dev-badge-styles';
    s.textContent = `
#${BADGE_ID} {
  position: fixed; left: 12px; bottom: 12px; z-index: 100000;
  font-family: 'DM Sans', -apple-system, sans-serif;
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  max-width: min(320px, calc(100vw - 24px));
}
#${BADGE_ID} .hh-dev-pill {
  display: inline-flex; align-items: center; gap: 7px;
  background: #1f2937; color: #fbbf24; border: 1px solid #f59e0b;
  border-radius: 999px; padding: 7px 12px 7px 10px;
  font-size: 11.5px; font-weight: 800; letter-spacing: .3px; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.28); user-select: none;
}
#${BADGE_ID} .hh-dev-dot { width: 8px; height: 8px; border-radius: 50%; background: #fbbf24; flex-shrink: 0; animation: hh-dev-blink 1.6s ease-in-out infinite; }
@keyframes hh-dev-blink { 50% { opacity: .35; } }
#${BADGE_ID} .hh-dev-panel {
  display: none; background: #111827; color: #e5e7eb; border: 1px solid #374151;
  border-radius: 12px; padding: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.4);
  width: 300px; max-width: calc(100vw - 24px);
}
#${BADGE_ID}.open .hh-dev-panel { display: block; }
#${BADGE_ID} .hh-dev-note { font-size: 11px; line-height: 1.5; color: #9ca3af; margin: 0 0 10px; }
#${BADGE_ID} .hh-dev-note b { color: #fbbf24; }
#${BADGE_ID} label { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; color: #9ca3af; margin-bottom: 5px; }
#${BADGE_ID} select {
  width: 100%; padding: 9px 10px; border-radius: 9px; border: 1px solid #374151;
  background: #1f2937; color: #f9fafb; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
#${BADGE_ID} .hh-dev-sub { font-size: 11px; color: #9ca3af; margin: 8px 0 0; min-height: 15px; }
#${BADGE_ID} .hh-dev-actions { display: flex; gap: 8px; margin-top: 12px; }
#${BADGE_ID} button.hh-dev-btn {
  flex: 1; padding: 8px; border-radius: 8px; border: none; cursor: pointer;
  font-family: inherit; font-size: 12px; font-weight: 700;
}
#${BADGE_ID} .hh-dev-btn--ghost { background: #374151; color: #e5e7eb; }
#${BADGE_ID} .hh-dev-btn--exit { background: #b91c1c; color: #fff; }
@media (prefers-reduced-motion: reduce) { #${BADGE_ID} .hh-dev-dot { animation: none; } }
`;
    document.head.appendChild(s);
}

/**
 * Mount the badge once. Idempotent.
 * @param {(reason:string)=>void} onExit  called when the developer taps "Exit dev mode".
 */
export function mountArtisanDevBadge({ onExit } = {}) {
    if (document.getElementById(BADGE_ID)) return;
    injectStyles();

    const states = listDevStates();
    const current = getDevStateKey();
    const options = states.map(s =>
        `<option value="${s.key}" ${s.key === current ? 'selected' : ''}>${s.label}</option>`).join('');
    const currentNote = states.find(s => s.key === current)?.note || '';

    const wrap = document.createElement('div');
    wrap.id = BADGE_ID;
    wrap.innerHTML = `
      <div class="hh-dev-panel" role="region" aria-label="Development mode controls">
        <p class="hh-dev-note"><b>Development Mode</b> — authentication and onboarding are temporarily bypassed. Real auth is untouched and returns when the flag is off.</p>
        <label for="hh-dev-state">Simulated artisan state</label>
        <select id="hh-dev-state">${options}</select>
        <p class="hh-dev-sub" id="hh-dev-sub">${currentNote}</p>
        <div class="hh-dev-actions">
          <button class="hh-dev-btn hh-dev-btn--ghost" id="hh-dev-close" type="button">Close</button>
          <button class="hh-dev-btn hh-dev-btn--exit" id="hh-dev-exit" type="button">Exit dev mode</button>
        </div>
      </div>
      <div class="hh-dev-pill" id="hh-dev-pill" role="button" tabindex="0" aria-label="Development mode — tap to switch artisan state">
        <span class="hh-dev-dot"></span> DEV MODE · ${states.find(s => s.key === current)?.label || current}
      </div>`;
    document.body.appendChild(wrap);

    const pill   = wrap.querySelector('#hh-dev-pill');
    const select = wrap.querySelector('#hh-dev-state');
    const sub    = wrap.querySelector('#hh-dev-sub');

    const toggle = () => wrap.classList.toggle('open');
    pill.addEventListener('click', toggle);
    pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    wrap.querySelector('#hh-dev-close').addEventListener('click', () => wrap.classList.remove('open'));

    select.addEventListener('change', () => {
        sub.textContent = states.find(s => s.key === select.value)?.note || '';
        setDevStateKey(select.value);
        // Reload so the guard re-resolves the new state exactly like a real change.
        location.reload();
    });

    wrap.querySelector('#hh-dev-exit').addEventListener('click', () => {
        if (typeof onExit === 'function') onExit('dev-exit');
    });
}
