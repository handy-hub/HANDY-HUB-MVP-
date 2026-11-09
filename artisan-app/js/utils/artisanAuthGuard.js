/**
 * artisanAuthGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central authentication and authorization guard for every artisan page.
 *
 * Security checks (in order):
 *   1. Firebase authentication — user must be signed in
 *   2. Firestore existence    — artisans/{uid} document must exist
 *   3. Role enforcement       — userType must be 'artisan'
 *   4. Status check           — account must not be suspended or banned
 *   5. KYC check (optional)   — verificationStatus must be 'approved'
 *
 * Usage:
 *   import { requireArtisanAuth } from './utils/artisanAuthGuard.js';
 *
 *   // Dashboard, jobs, wallet — full guard (auth + role + not suspended)
 *   const { user, artisan } = await requireArtisanAuth();
 *
 *   // Job acceptance, earnings — must also be KYC-approved
 *   const { user, artisan } = await requireArtisanAuth({ requireApproved: true });
 *
 *   // Onboarding — auth + role only (pending artisans must reach this page)
 *   const { user, artisan } = await requireArtisanAuth({ allowPending: true });
 *
 * The FIRST verification in a tab blocks rendering via a full-screen overlay
 * until checks complete. After that, navigating between artisan pages paints
 * immediately from this tab's last verdict (same uid only) while the profile
 * is re-read in the background; a changed verdict (suspended, role, KYC) then
 * blocks the page. All redirects use location.replace() so protected pages are
 * never in browser history.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getAppContainer }              from '../../../shared/js/app/container.js';
import { initializePushNotifications } from '../../../shared/js/services/pushNotificationService.js';
import { isArtisanDevAccessEnabled }   from '../../../shared/js/config/devAccess.js';
import { getDevArtisanSession, endDevSession } from '../../../shared/dev/artisanDevSession.js';
import { ensureArtisanAccount, nextArtisanPage } from './artisanAccount.js';
import { SUPPORT_CONTACTS }              from '../../../shared/js/config/supportConfig.js';
import { clearUserSession }              from '../../../shared/js/utils/clearUserSession.js';
// Defines window.HH_State (classic script). The guard tells it who is signed in,
// which scopes every cache instantView keeps (CLAUDE.md §1) to this artisan and
// lets sign-out purge exactly that artisan's cached data.
import '../../../shared/js/services/stateService.js';

/** Scope this tab's cached data to the artisan the guard just verified. */
function setSessionUser(uid) {
  try { window.HH_State?.setUser(uid); } catch (_) { /* storage blocked: no cache, no harm */ }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const LOGIN_URL        = 'login.html';
const RETURN_KEY       = 'hh_artisan_return_url';
const SESSION_KEY      = 'hh_artisan_session';
// Durable 'this device has signed in before' marker (localStorage, survives
// tab close). Used ONLY to decide wait-vs-redirect on a slow auth restore.
const LAST_UID_KEY     = 'hh_artisan_last_uid';
// A MESSAGE timer, not an auth decision. It can never redirect or sign out.
const GUARD_NOTICE_MS = 6000;
const OVERLAY_ID       = 'artisan-auth-overlay';

// ── Overlay CSS (injected once) ───────────────────────────────────────────────
// The design system's own values (artisan-app/css/tokens.css), each with that
// value as its fallback, so these screens look the same on a page that does
// not load the tokens. Orange carries an ink label (design decision 01: white
// on it is 2.8:1). Phase 5.
const OVERLAY_CSS = `
#artisan-auth-overlay {
  position: fixed; inset: 0; z-index: 99999;
  font-family: var(--fx-font, 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  -webkit-font-smoothing: antialiased;
  display: flex; align-items: center; justify-content: center;
  background: var(--fx-paper, #FFFFFF); color: var(--fx-ink, #111316);
  transition: opacity .25s ease; overflow-y: auto;
}
#artisan-auth-overlay.ag-fade { opacity: 0; pointer-events: none; }
.ag-center { padding: 32px 20px; max-width: 28rem; width: 100%; box-sizing: border-box; }
.ag-word { margin: 0 0 32px; display: flex; flex-direction: column; gap: 2px; }
.ag-word b { font-weight: 650; font-size: 1.5rem; line-height: 1.875rem; letter-spacing: -0.01em; }
.ag-word span { font-weight: 550; font-size: .875rem; line-height: 1.25rem; color: var(--fx-ink-2, #3B4048); }
.ag-spinner {
  width: 32px; height: 32px; margin: 0 0 16px;
  border: 3px solid var(--fx-line, #E6E7E9); border-top-color: var(--fx-ink, #111316);
  border-radius: 50%; animation: ag-spin .7s linear infinite;
}
@keyframes ag-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ag-spinner { animation: none; } }
.ag-loading-text { margin: 0; font-size: .875rem; line-height: 1.25rem; color: var(--fx-ink-3, #62676F); }
.ag-title { margin: 0 0 8px; font-weight: 650; font-size: 1.5rem; line-height: 1.875rem; letter-spacing: -0.01em; }
.ag-sub { margin: 0 0 24px; font-size: 1rem; line-height: 1.5rem; color: var(--fx-ink-2, #3B4048); }
.ag-actions { display: grid; gap: 8px; }
.ag-btn {
  width: 100%; min-height: 48px; padding: 0 16px; border: 0; border-radius: var(--fx-r-control, 8px);
  font: inherit; font-weight: 650; font-size: 1rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box;
}
.ag-btn:focus-visible { outline: 2px solid var(--fx-ink, #111316); outline-offset: 2px; }
.ag-btn-primary   { background: var(--fx-accent, #F97316); color: var(--fx-on-accent, #111316); }
.ag-btn-secondary { background: var(--fx-well, #F3F3F2); color: var(--fx-ink, #111316); }
.ag-btn[disabled] { opacity: .6; cursor: default; }
`;

// ── Overlay state screens ─────────────────────────────────────────────────────
// Each says what the state is and the one thing to do about it. None promises
// a review time (decision of 2026-11-09), and none claims a status the server
// has not given.
const WORDMARK = '<p class="ag-word"><b>Fidus X</b><span>for professionals</span></p>';
const screen = (title, body, actions) => `
    <div class="ag-center" role="dialog" aria-modal="true" aria-labelledby="ag-title">
      ${WORDMARK}
      <h2 class="ag-title" id="ag-title">${title}</h2>
      <p class="ag-sub" id="ag-sub">${body}</p>
      <div class="ag-actions">${actions}</div>
    </div>`;
const SIGN_OUT = '<button class="ag-btn ag-btn-secondary" type="button" onclick="_agSignOut()">Sign out</button>';

const SCREENS = {
  loading: () => `
    <div class="ag-center" role="status">
      ${WORDMARK}
      <div class="ag-spinner" aria-hidden="true"></div>
      <p class="ag-loading-text">Checking your account…</p>
    </div>`,

  suspended: () => screen('Your account is suspended',
    `You can't take jobs or use your account until Fidus X support resolves this.${SUPPORT_CONTACTS.email ? ` Email ${SUPPORT_CONTACTS.email}.` : ''}`,
    `${SUPPORT_CONTACTS.email ? `<a class="ag-btn ag-btn-primary" href="mailto:${SUPPORT_CONTACTS.email}">Email support</a>` : ''}${SIGN_OUT}`),

  pending: () => screen('Your application is being reviewed',
    "Fidus X is checking your details. We'll let you know when there is a decision.",
    `<button class="ag-btn ag-btn-primary" type="button" onclick="_agGoToDashboard()">Go to Today</button>${SIGN_OUT}`),

  rejected: () => screen('Your application needs changes',
    'Fidus X could not approve it as it was sent. Open it to see what to change, then send it again.',
    `<a class="ag-btn ag-btn-primary" href="onboarding.html">Review and resubmit</a>${SIGN_OUT}`),

  // A NETWORK failure, kept strictly separate from `unauthorized`. It offers a
  // retry and NEVER a sign-out: the session is valid, and destroying it is the
  // opposite of what this artisan needs.
  offline: () => screen("Can't reach the server",
    "You're still signed in. We couldn't load your profile because the connection dropped.",
    '<button class="ag-btn ag-btn-primary" type="button" onclick="_agRetry()">Try again</button>'),

  // Signed in, but no artisan profile yet (a first Google sign-in that did not
  // come through signup). Authentication worked; the account just needs
  // creating — so say that and do it, instead of "Access Denied" (AR-09).
  setup: () => `
    <div class="ag-center" role="dialog" aria-modal="true" aria-labelledby="ag-title">
      ${WORDMARK}
      <h2 class="ag-title" id="ag-title">Finish setting up your account</h2>
      <p class="ag-sub" id="ag-setup-msg">You're signed in. Create your professional profile to continue to your application.</p>
      <div class="ag-actions">
        <button class="ag-btn ag-btn-primary" type="button" id="ag-setup-btn" onclick="_agFinishSetup()">Create my profile</button>
        ${SIGN_OUT}
      </div>
    </div>`,

  unauthorized: () => screen("This account can't use the professional app",
    'Sign in with your Fidus X professional account. Customers use the Fidus X customer app.',
    SIGN_OUT),
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('ag-styles')) return;
  const s = document.createElement('style');
  s.id = 'ag-styles';
  s.textContent = OVERLAY_CSS;
  document.head.appendChild(s);
}

function showOverlay(type = 'loading') {
  injectStyles();
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = SCREENS[type]?.() || SCREENS.loading();
  overlay.style.opacity  = '1';
  overlay.style.pointerEvents = 'all';
  overlay.classList.remove('ag-fade');
}

function hideOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.classList.add('ag-fade');
  setTimeout(() => overlay?.remove(), 280);
}

// ── Session helpers ───────────────────────────────────────────────────────────
function cacheSession(uid, artisanData) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ uid, ...artisanData, _ts: Date.now() }));
    // Durable marker: sessionStorage dies with the tab, so it cannot answer
    // "has this device ever signed in?" after an app restart. The guard needs
    // that answer to decide whether a slow Firebase resolve means "still
    // restoring" (wait) or "genuinely signed out" (go to login). Holds no
    // credentials — only the fact that a session once existed here.
    localStorage.setItem(LAST_UID_KEY, uid);
  } catch (_) {}
}

/**
 * The verdict this tab last reached for `uid`, regardless of age — the guard
 * revalidates it in the background on every load, so its age only bounds how
 * stale the FIRST paint can be, never an access decision. Different uid → null.
 */
function readVerifiedSession(uid) {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    return s && s.uid === uid ? s : null;
  } catch { return null; }
}

/**
 * Merge a write this client just made into the cached verdict, so the next
 * page's instant paint shows it (e.g. a settings toggle, a profile edit).
 * Shallow by design: every artisan write passes flat fields.
 */
export function patchArtisanSession(patch) {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !patch) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ...patch }));
  } catch (_) {}
}
// Classic (non-module) scripts such as artisanFloatingNav.js reach it here.
window._agPatchSession = patchArtisanSession;

/**
 * Which screen, if any, blocks this artisan on this page. null = allowed.
 * The single gate both the instant path and the network path apply.
 */
function gateFor(artisan, { requireApproved, allowPending }) {
  if (!artisan || artisan.userType !== 'artisan') return 'unauthorized';
  const status = (artisan.status || '').toLowerCase();
  if (status === 'suspended' || status === 'banned') return 'suspended';
  const kycStatus = (artisan.verificationStatus || '').toLowerCase();
  if (!allowPending && requireApproved && kycStatus !== 'approved') {
    return kycStatus === 'rejected' ? 'rejected' : 'pending';
  }
  return null;
}

export function getArtisanSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Invalidate cache older than 5 minutes
    if (!s._ts || Date.now() - s._ts > 5 * 60 * 1000) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

function saveReturnUrl() {
  try {
    const url = window.location.href;
    // Only save if it's an artisan page (not login/signup)
    if (!url.includes('login') && !url.includes('signup')) {
      sessionStorage.setItem(RETURN_KEY, url);
    }
  } catch (_) {}
}

export function consumeReturnUrl() {
  try {
    const url = sessionStorage.getItem(RETURN_KEY);
    if (url) sessionStorage.removeItem(RETURN_KEY);
    if (url && new URL(url).origin === window.location.origin) return url;
  } catch (_) {}
  return null;
}

// ── Exposed helpers (called from overlay buttons) ─────────────────────────────
/**
 * Retry after a connection failure. Deliberately a plain reload: it re-runs the
 * guard from the top with the session still intact. It does NOT sign out, and
 * it does NOT clear any auth state — the whole point of the offline overlay is
 * that nothing about the session was wrong.
 */
window._agFinishSetup = async function () {
  const btn = document.getElementById('ag-setup-btn');
  const msg = document.getElementById('ag-setup-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Setting up…'; }
  const acct = await ensureArtisanAccount();
  if (acct.ok) { window.location.replace(nextArtisanPage(acct.verificationStatus)); return; }
  if (msg) msg.textContent = acct.message;
  if (btn) {
    btn.disabled = acct.reason === 'customer_account' || acct.reason === 'admin_account';
    btn.textContent = 'Try again';
  }
};

window._agRetry = function () {
  try { window.location.reload(); } catch (_) {}
};

window._agSignOut = async function () {
  // Dev mode: there is no real Firebase user to sign out. End the mock session
  // and return to login. (Guarded so it only ever short-circuits in dev.)
  if (isArtisanDevAccessEnabled()) {
    endDevSession();
    sessionStorage.removeItem(SESSION_KEY);
    // Explicit sign-out is the one case where the device should forget it
    // ever had a session, so a slow restore correctly falls back to login.
    try { localStorage.removeItem(LAST_UID_KEY); } catch (_) {}
    window.location.replace(LOGIN_URL);
    return;
  }
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    try { localStorage.removeItem(LAST_UID_KEY); } catch (_) {}
    // Purge this artisan's cached screens (instantView) before the next person
    // can sign in on this device.
    try { clearUserSession(window.HH_State?.currentUid?.() || getAppContainer().services.authService.getCurrentUser?.()?.uid); } catch (_) {}
    const { services: { authService } } = getAppContainer();
    await authService.signOut?.() || await getAppContainer().services.sessionService.logout();
  } catch (_) {}
  window.location.replace(LOGIN_URL);
};

window._agGoToDashboard = function () {
  window.location.replace('dashboard.html');
};

// ── Main guard ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {boolean} [opts.requireApproved=false]
 *   If true, verificationStatus must be 'approved'. Use for job acceptance,
 *   wallet withdrawals, and other actions only verified artisans may perform.
 *   Pending/rejected artisans see a KYC-required screen.
 *
 * @param {boolean} [opts.allowPending=false]
 *   If true, the guard does NOT redirect pending/rejected artisans — they are
 *   allowed to reach the page (used for the onboarding form itself).
 *
 * @returns {Promise<{ user: object, artisan: object }>}
 *   Resolves with the Firebase user and Firestore artisan document data.
 *   Never resolves if auth fails — guard redirects instead.
 */
export async function requireArtisanAuth({ requireApproved = false, allowPending = false } = {}) {
  // ═══════════════════════════════════════════════════════════════════════════
  // DEVELOPMENT ACCESS MODE (temporary, non-production only)
  // When enabled, resolve a controlled mock session instead of real Firebase +
  // Firestore. It still HONOURS the same gates (suspended / pending / error) per
  // the selected dev state, so the guard's real access contract is reproduced,
  // not discarded. Everything below this block — the entire real system — is
  // untouched and runs verbatim when the flag is off.
  // ═══════════════════════════════════════════════════════════════════════════
  if (isArtisanDevAccessEnabled()) {
    return resolveDevArtisanAccess({ requireApproved, allowPending });
  }

  // RENDER FIRST (CLAUDE.md §1). If this tab already verified an artisan, the
  // page is NOT covered by "Verifying your account…" on every navigation: the
  // verdict is confirmed against Firebase's restored user (local, no network)
  // and the page paints at once, while the Firestore read runs behind it. Only
  // a tab with no verdict yet — first page, after sign-out, another account —
  // is blocked while the checks run.
  const hadVerdict = (() => {
    try { return !!sessionStorage.getItem(SESSION_KEY); } catch { return false; }
  })();

  // Block ALL page content immediately — overlay covers the body before
  // any HTML renders visibly.
  if (!hadVerdict) showOverlay('loading');

  return new Promise((resolve) => {
    // Slowness is NOT a logout. Firebase restores a session from local
    // persistence without network, so a slow resolve means the SDK is still
    // starting — not that this artisan signed out. Redirecting here threw away
    // valid sessions on 2G, cold starts and backgrounded tabs, which is the
    // "it logged me out on bad internet" complaint.
    //
    // On a device that has signed in before we keep waiting and say so. Only a
    // device with no prior session falls back to login, because there is then
    // genuinely nothing to restore.
    // The previous version branched on a localStorage marker to decide whether
    // to wait or redirect. That marker is only written AFTER a successful
    // authenticated session on this device, so it is necessarily absent on a
    // NEW DEVICE — and a legitimately signed-in artisan was redirected to login
    // on their first slow page load. Elapsed time is not evidence about
    // authentication; only Firebase resolving a null user is.
    // With a verdict on screen the page's own loading states are showing, so a
    // slow restore must not throw the blocking overlay over them.
    const timeout = hadVerdict ? null : setTimeout(() => showOverlay('loading'), GUARD_NOTICE_MS);

    const { services: { authService, databaseService } } = getAppContainer();

    authService.waitForUser()
      .then(async (user) => {
        clearTimeout(timeout);

        // ── Step 1: authentication ────────────────────────────────
        // Reached only once Firebase has RESOLVED its initial state (restored
        // from local persistence, no network required), so a null user here is
        // a real answer rather than a slow one.
        if (!user) {
          saveReturnUrl();
          window.location.replace(LOGIN_URL);
          return;
        }

        // ── Instant path: this tab already verified THIS uid ──────
        // The same gate the network path applies, run on the last verdict.
        // Firestore rules and Cloud Functions remain the enforcement; this
        // only decides what to paint while the fresh read is in flight.
        const cached = readVerifiedSession(user.uid);
        if (cached && !gateFor(cached, { requireApproved, allowPending })) {
          setSessionUser(user.uid);
          resolve({ user, artisan: cached });
          initializePushNotifications(user.uid, 'artisan').catch(() => {});
          databaseService.getDocument('artisans', user.uid).then((snap) => {
            if (!snap || !snap.exists) { showOverlay('setup'); return; }
            const fresh = snap.data;
            const blocked = gateFor(fresh, { requireApproved, allowPending });
            // Suspended, role changed or KYC withdrawn since the last page:
            // block now, exactly as the network path would have.
            if (blocked) { showOverlay(blocked); return; }
            cacheSession(user.uid, fresh);
            // Pages hold this object; later reads (handlers, re-renders) see
            // the fresh document instead of the one the paint started from.
            Object.assign(cached, fresh);
          }).catch((err) => {
            // Offline: the session is valid and the page is already useful.
            console.warn('[artisanGuard] background revalidation failed (page kept):', err.message);
          });
          return;
        }
        if (hadVerdict) showOverlay('loading');

        // ── Step 2: Firestore artisan document ────────────────────
        let artisanSnap;
        try {
          artisanSnap = await databaseService.getDocument('artisans', user.uid);
        } catch (err) {
          // A read failure is a NETWORK condition, not an authorization one.
          // Showing 'Access Denied' here told a valid artisan they were not an
          // artisan, and offered signing out as the remedy.
          console.warn('[artisanGuard] Firestore read error (session kept):', err.message);
          showOverlay('offline');
          return;
        }

        if (!artisanSnap || !artisanSnap.exists) {
          // Authenticated, no artisan profile. A customer is refused by the
          // server step itself (role isolation); anyone else is offered it.
          showOverlay('setup');
          return;
        }

        const artisan = artisanSnap.data;

        // ── Steps 3–5: role, suspension/ban, KYC (when required) ──
        const blocked = gateFor(artisan, { requireApproved, allowPending });
        if (blocked) {
          showOverlay(blocked);
          return;
        }

        // ── All checks passed ─────────────────────────────────────
        cacheSession(user.uid, artisan);
        setSessionUser(user.uid);
        hideOverlay();
        initializePushNotifications(user.uid, 'artisan').catch(() => {});
        resolve({ user, artisan });
      })
      .catch(() => {
        clearTimeout(timeout);
        saveReturnUrl();
        window.location.replace(LOGIN_URL);
      });
  });
}

// ── Development Access Mode resolver ──────────────────────────────────────────
// Mirrors the real guard's outcomes for the selected dev state, so every access
// path (enter / suspended / pending / error) can be exercised without a backend.
// Always mounts the dev badge + state switcher (above the overlay) so the state
// is switchable even when the current state blocks the page. Never touches
// Firebase or push notifications.
async function resolveDevArtisanAccess({ requireApproved, allowPending }) {
  showOverlay('loading');
  // Badge module is loaded lazily so its code + styles never reach production.
  const { mountArtisanDevBadge } = await import('../../../shared/dev/artisanDevBadge.js');
  const { user, artisan, gate } = getDevArtisanSession();

  mountArtisanDevBadge({ onExit: () => window._agSignOut() });

  return new Promise((resolve) => {
    // data-error state → exercise the error path.
    if (!artisan || gate === 'unauthorized') { showOverlay('unauthorized'); return; }
    // suspended/banned → suspended screen (same as real).
    if (gate === 'suspended') { showOverlay('suspended'); return; }
    // KYC-required pages block a pending artisan, unless the page allows pending.
    if (gate === 'pending' && requireApproved && !allowPending) { showOverlay('pending'); return; }

    cacheSession(user.uid, artisan);
    hideOverlay();
    resolve({ user, artisan });
  });
}

// ── Shared, dev-aware auth accessors ──────────────────────────────────────────
// Artisan pages must resolve the current user through THESE, not by calling
// Firebase Auth (authService.subscribeToAuthState / waitForUser) directly. In
// production they delegate 1:1 to the real authService; in dev mode they serve
// the one canonical mock session and never bounce to login. This is what lets a
// page's post-guard "session expiry" watcher keep working under the bypass.

/**
 * Subscribe to the artisan auth state. Dev mode: fires once with the mock user
 * and returns a no-op unsubscribe. Production: the real Firebase subscription.
 * @param {(user: object|null) => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeToArtisanAuthState(cb) {
  if (isArtisanDevAccessEnabled()) {
    try { cb(getDevArtisanSession().user); } catch (_) {}
    return () => {};
  }
  const { services: { authService } } = getAppContainer();
  return authService.subscribeToAuthState(cb);
}

/**
 * Resolve the current artisan user. Dev mode: the mock user. Production: the
 * real awaited Firebase user (may be null).
 * @returns {Promise<object|null>}
 */
export async function waitForArtisanUser() {
  if (isArtisanDevAccessEnabled()) return getDevArtisanSession().user;
  const { services: { authService } } = getAppContainer();
  return authService.waitForUser();
}

/**
 * Lightweight check — returns the current artisan session from cache, or
 * null if not available. Does NOT redirect. Use for non-critical checks
 * after requireArtisanAuth() has already passed.
 */
export function getSessionArtisan() {
  return getArtisanSession();
}

/**
 * Check whether the currently-authenticated artisan is allowed to accept jobs.
 * Returns true only for approved, active artisans.
 * Call AFTER requireArtisanAuth() to avoid a second Firestore read.
 */
export function canAcceptJobs(artisan) {
  if (!artisan) return false;
  const status    = (artisan.status || '').toLowerCase();
  const kycStatus = (artisan.verificationStatus || '').toLowerCase();
  return status !== 'suspended' && status !== 'banned' && kycStatus === 'approved';
}
