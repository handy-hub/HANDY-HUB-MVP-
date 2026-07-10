/**
 * resumeCard.js — Dashboard "request in progress" recovery card
 *
 * Closes the F2 dead-end. An inspection-track booking's pay-callout and
 * quote-review controls live on other screens; a customer who leaves the flow
 * after requesting had no way back. This card is a persistent, live nudge on the
 * dashboard that routes them straight to whatever they need to do next.
 *
 * Source of truth is a live Firestore subscription (bookingRepository), NOT
 * sessionStorage — the customer might request on their phone and reopen on a
 * laptop; the card must follow the account, not the browser tab.
 *
 * Architecture mirrors nearbyPros.js: no static shared imports, all resolved
 * through resilient dynamic import() so the module evaluates in every serving
 * context (project-root server, customer-app-only server, Firebase Hosting).
 */

'use strict';

const MOUNT_ID = 'resume-card-mount';

let _unsub   = null;
let _mount   = null;
let _router  = null;   // { bookingHref, isResumableInspection, resumeSummary }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Resilient shared-module import (two candidate roots) ─────────────────── */
async function importShared(relFromJs) {
  // relFromJs is the path RELATIVE TO customer-app/js/ (e.g. 'app/container.js').
  const candidates = [
    `../../shared/js/${relFromJs}`,  // customer-app/js/ → project root layout
    `../shared/js/${relFromJs}`,     // customer-app/    → hosting/flattened layout
  ];
  let lastErr;
  for (const path of candidates) {
    try { return await import(path); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function loadDeps() {
  const [routerMod, containerMod, repoMod] = await Promise.all([
    importShared('domain/bookingRouter.js'),
    importShared('app/container.js'),
    importShared('data/repositories/bookingRepository.js'),
  ]);
  _router = routerMod;
  const container = containerMod.getAppContainer();
  const databaseService = container.services.databaseService;
  const authService     = container.services.authService;
  const bookingRepo     = repoMod.createBookingRepository({ databaseService });
  return { authService, bookingRepo };
}

/* ── Render ───────────────────────────────────────────────────────────────── */
function render(booking) {
  if (!_mount) return;

  if (!booking) {
    _mount.hidden = true;
    _mount.innerHTML = '';
    return;
  }

  const { label, cta, urgent } = _router.resumeSummary(booking);
  const href = _router.bookingHref({ ...booking, bookingId: booking.id });

  _mount.hidden = false;
  _mount.innerHTML = `
    <button type="button" class="resume-card${urgent ? ' resume-card--urgent' : ''}" id="resume-card-btn">
      <span class="resume-card-pulse" aria-hidden="true"></span>
      <span class="resume-card-body">
        <span class="resume-card-kicker">Request in progress</span>
        <span class="resume-card-label">${esc(label)}</span>
      </span>
      <span class="resume-card-cta">
        ${esc(cta)}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    </button>`;

  _mount.querySelector('#resume-card-btn')?.addEventListener('click', () => {
    window.location.href = href;
  });
}

/**
 * Pick the single most action-worthy booking to surface. Urgent states
 * (quote ready, callout unpaid) win; otherwise the most recently updated.
 */
function pickResumable(bookings) {
  const resumable = bookings
    .map(r => ({ id: r.id, ...(r.data || {}) }))
    .filter(b => _router.isResumableInspection(b));
  if (!resumable.length) return null;

  const score = (b) => {
    const s = String(b.status || '').toLowerCase();
    if (s === 'quoted') return 3;
    if (s === 'accepted' && !b.calloutPaid) return 2;
    return 1;
  };
  resumable.sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return resumable[0];
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */
export async function initResumeCard() {
  _mount = document.getElementById(MOUNT_ID);
  if (!_mount) return;

  let deps;
  try {
    deps = await loadDeps();
  } catch (err) {
    // Shared modules unreachable (e.g. customer-app-only test server) — the card
    // is a progressive enhancement; stay hidden rather than error.
    console.warn('[resumeCard] deps unavailable — card disabled:', err?.message);
    return;
  }

  const { authService, bookingRepo } = deps;

  authService.subscribeToAuthState((user) => {
    if (_unsub) { _unsub(); _unsub = null; }
    if (!user) { render(null); return; }

    _unsub = bookingRepo.subscribeByCustomerId(
      user.uid,
      (records) => render(pickResumable(records)),
      (err) => { console.warn('[resumeCard] subscription error:', err?.message); render(null); },
    );
  });

  window.addEventListener('pagehide', () => { if (_unsub) _unsub(); });
}
