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
 * The guard blocks all page rendering via a full-screen overlay until checks
 * complete. No content flashes before verification. All redirects use
 * location.replace() so protected pages are never in browser history.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getAppContainer }              from '../../../shared/js/app/container.js';
import { initializePushNotifications } from '../../../shared/js/services/pushNotificationService.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const LOGIN_URL        = 'login.html';
const RETURN_KEY       = 'hh_artisan_return_url';
const SESSION_KEY      = 'hh_artisan_session';
const GUARD_TIMEOUT_MS = 6000; // 6s before fallback redirect to login
const OVERLAY_ID       = 'artisan-auth-overlay';

// ── Overlay CSS (injected once) ───────────────────────────────────────────────
const OVERLAY_CSS = `
#artisan-auth-overlay {
  position: fixed; inset: 0; z-index: 99999;
  font-family: 'DM Sans', -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  display: flex; align-items: center; justify-content: center;
  background: #fff; transition: opacity .25s ease;
}
#artisan-auth-overlay.ag-fade { opacity: 0; pointer-events: none; }

.ag-center { text-align: center; padding: 32px 24px; max-width: 360px; width: 100%; }

/* Spinner */
.ag-spinner {
  width: 44px; height: 44px; margin: 0 auto 20px;
  border: 3.5px solid #f3f4f6;
  border-top-color: #F97316;
  border-radius: 50%;
  animation: ag-spin .7s linear infinite;
}
@keyframes ag-spin { to { transform: rotate(360deg); } }
.ag-loading-text { font-size: 14px; color: #9CA3AF; font-weight: 500; }

/* Icon states */
.ag-icon {
  width: 72px; height: 72px; border-radius: 22px;
  margin: 0 auto 20px;
  display: flex; align-items: center; justify-content: center;
}
.ag-icon.suspended  { background: #FEF2F2; }
.ag-icon.pending    { background: #FFF7ED; }
.ag-icon.rejected   { background: #FEF2F2; }
.ag-icon.unauth     { background: #F3F4F6; }

.ag-title {
  font-size: 20px; font-weight: 800; color: #111827; margin-bottom: 8px;
}
.ag-sub {
  font-size: 14px; color: #6B7280; line-height: 1.55; margin-bottom: 24px;
}
.ag-btn {
  width: 100%; height: 50px; border: none; border-radius: 14px;
  font-family: inherit; font-size: 15px; font-weight: 700; cursor: pointer;
  margin-bottom: 10px; display: flex; align-items: center; justify-content: center;
  transition: opacity .15s;
}
.ag-btn:active { opacity: .8; }
.ag-btn-primary   { background: #F97316; color: #fff; }
.ag-btn-secondary { background: #F3F4F6; color: #374151; }
.ag-btn-danger    { background: #EF4444; color: #fff; }
`;

// ── Overlay state screens ─────────────────────────────────────────────────────
const SCREENS = {
  loading: () => `
    <div class="ag-center">
      <div class="ag-spinner"></div>
      <p class="ag-loading-text">Verifying your account…</p>
    </div>`,

  suspended: () => `
    <div class="ag-center">
      <div class="ag-icon suspended">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#EF4444" stroke-width="2"/>
          <path d="M4.93 4.93l14.14 14.14" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="ag-title">Account Suspended</p>
      <p class="ag-sub">Your account has been suspended. Please contact HandyHub support to resolve this.</p>
      <button class="ag-btn ag-btn-secondary" onclick="window.location.href='mailto:support@handyhub.app'">
        Contact Support
      </button>
      <button class="ag-btn ag-btn-secondary" onclick="_agSignOut()">Sign Out</button>
    </div>`,

  pending: () => `
    <div class="ag-center">
      <div class="ag-icon pending">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#F97316" stroke-width="2"/>
          <path d="M12 6v6l4 2" stroke="#F97316" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="ag-title">Verification Pending</p>
      <p class="ag-sub">Your account is under review. We'll notify you within 1–2 business days once approved.</p>
      <button class="ag-btn ag-btn-primary" onclick="_agGoToDashboard()">Go to Dashboard</button>
      <button class="ag-btn ag-btn-secondary" onclick="_agSignOut()">Sign Out</button>
    </div>`,

  rejected: () => `
    <div class="ag-center">
      <div class="ag-icon rejected">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="#EF4444" stroke-width="2"/>
          <line x1="12" y1="9" x2="12" y2="13" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/>
          <line x1="12" y1="17" x2="12.01" y2="17" stroke="#EF4444" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="ag-title">Verification Rejected</p>
      <p class="ag-sub">Your verification was not approved. Please review the feedback and resubmit your documents.</p>
      <button class="ag-btn ag-btn-primary" onclick="window.location.href='onboarding.html'">Resubmit Documents</button>
      <button class="ag-btn ag-btn-secondary" onclick="_agSignOut()">Sign Out</button>
    </div>`,

  unauthorized: () => `
    <div class="ag-center">
      <div class="ag-icon unauth">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="11" width="18" height="11" rx="2" stroke="#9CA3AF" stroke-width="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="ag-title">Access Denied</p>
      <p class="ag-sub">This area is restricted to verified artisans. If you're an artisan, please sign in with the correct account.</p>
      <button class="ag-btn ag-btn-secondary" onclick="_agSignOut()">Sign Out</button>
    </div>`,
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
  } catch (_) {}
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
window._agSignOut = async function () {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(RETURN_KEY);
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
  // Block ALL page content immediately — overlay covers the body before
  // any HTML renders visibly.
  showOverlay('loading');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Hard timeout — Firebase took too long, safe fallback
      saveReturnUrl();
      window.location.replace(LOGIN_URL);
    }, GUARD_TIMEOUT_MS);

    const { services: { authService, databaseService } } = getAppContainer();

    authService.waitForUser()
      .then(async (user) => {
        clearTimeout(timeout);

        // ── Step 1: authentication ────────────────────────────────
        if (!user) {
          saveReturnUrl();
          window.location.replace(LOGIN_URL);
          return;
        }

        // ── Step 2: Firestore artisan document ────────────────────
        let artisanSnap;
        try {
          artisanSnap = await databaseService.getDocument('artisans', user.uid);
        } catch (err) {
          console.warn('[artisanGuard] Firestore read error:', err.message);
          showOverlay('unauthorized');
          return;
        }

        if (!artisanSnap || !artisanSnap.exists) {
          // User is authenticated but has no artisan document
          // Could be a customer who typed the URL manually
          showOverlay('unauthorized');
          return;
        }

        const artisan = artisanSnap.data;

        // ── Step 3: role check ────────────────────────────────────
        if (artisan.userType !== 'artisan') {
          showOverlay('unauthorized');
          return;
        }

        // ── Step 4: suspension / ban check ───────────────────────
        const status = (artisan.status || '').toLowerCase();
        if (status === 'suspended' || status === 'banned') {
          showOverlay('suspended');
          return;
        }

        // ── Step 5: KYC check ─────────────────────────────────────
        const kycStatus = (artisan.verificationStatus || '').toLowerCase();
        const isApproved = kycStatus === 'approved';

        if (!allowPending && requireApproved && !isApproved) {
          // This page requires KYC approval — show appropriate screen
          if (kycStatus === 'rejected') {
            showOverlay('rejected');
          } else {
            showOverlay('pending');
          }
          return;
        }

        // ── All checks passed ─────────────────────────────────────
        cacheSession(user.uid, artisan);
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
