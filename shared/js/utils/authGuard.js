/**
 * authGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Import this module at the TOP of any protected customer page (as a module
 * script) to gate access behind Firebase authentication.
 *
 * Usage (in the HTML page's <script type="module">):
 *
 *   import { requireAuth } from '../shared/js/utils/authGuard.js';
 *   await requireAuth();     // throws / redirects if unauthenticated
 *   // page-specific init below...
 *
 * Or as a standalone script tag (self-executing):
 *
 *   <script type="module" src="../shared/js/utils/authGuard.js"></script>
 *
 * Behaviour
 * ─────────
 * 1. Calls authService.waitForUser() to get the current Firebase user.
 * 2. If no user → saves the intended URL to sessionStorage('hh_auth_redirect')
 *    then sends the browser to login.html.
 * 3. If user exists → resolves immediately, page init continues.
 * 4. A 6-second timeout ensures the guard never hangs a page load forever —
 *    on timeout it redirects to login as a safe fallback. 6 s covers Ghana
 *    mobile cold-starts on 2G/3G; 3 s caused false logout redirects.
 *
 * The login page reads 'hh_auth_redirect' after a successful sign-in and
 * forwards the user to their originally intended destination.
 */

import { getAppContainer } from '../app/container.js';
import { resolveAppRole, ROLE } from './roleGuard.js';

const AUTH_REDIRECT_KEY    = 'hh_auth_redirect';
const LOGIN_PAGE           = 'login.html';
// Absolute path to the artisan app so a mis-routed artisan can be bounced to
// the application they actually belong to.
const ARTISAN_APP_URL      = '/artisan-app/login.html';
// 6 s allows Firebase to initialise on Ghana mobile networks (2G/3G cold-start).
// 3 s was too aggressive and caused false logout redirects on slow connections.
const AUTH_GUARD_TIMEOUT_MS = 6000;
const DENY_OVERLAY_ID       = 'hh-role-deny-overlay';

/**
 * Resolve the login page URL relative to the current page.
 * Works for pages at any nesting depth inside the project.
 */
function resolveLoginUrl() {
  // Determine the relative path depth from current page to customer-app/login.html
  const path = window.location.pathname;

  // If we're already inside customer-app/ (one level deep from root)
  if (path.includes('/customer-app/')) {
    return LOGIN_PAGE; // same directory
  }

  // Fallback — point to the absolute path segment
  return `/customer-app/${LOGIN_PAGE}`;
}

const AUTH_WAIT_ID = 'hh-auth-waiting';

/**
 * Shown when session restoration is taking a while on a device that HAS signed
 * in before. Replaces the old behaviour of redirecting to login, which threw
 * away a valid session because the network was slow.
 *
 * Deliberately non-blocking and self-removing: if Firebase answers a moment
 * later the page continues normally and this disappears.
 */
function showAuthWaiting() {
  if (document.getElementById(AUTH_WAIT_ID)) return;
  try {
    const el = document.createElement('div');
    el.id = AUTH_WAIT_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
      'z-index:99999', 'max-width:calc(100vw - 32px)',
      'background:#1A1416', 'color:#fff', 'border-radius:10px',
      'padding:10px 16px', 'font:500 13.5px system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 24px -8px rgba(0,0,0,.45)', 'text-align:center',
    ].join(';');
    el.textContent = 'Reconnecting — your session is safe.';
    document.body.appendChild(el);
  } catch { /* pre-body or blocked DOM — non-fatal, the guard still resolves */ }
}

function hideAuthWaiting() {
  try { document.getElementById(AUTH_WAIT_ID)?.remove(); } catch { /* non-fatal */ }
}

/**
 * Save the current URL so login.html can redirect back after authentication.
 */
function saveReturnUrl() {
  try {
    sessionStorage.setItem(AUTH_REDIRECT_KEY, window.location.href);
  } catch (_) {
    // sessionStorage may be blocked in some private-browsing modes — ignore
  }
}

/**
 * Redirect to the login page.
 * Uses replace() so the protected page isn't in the browser history
 * (pressing back from login won't bounce the user back to a protected page).
 */
function redirectToLogin() {
  saveReturnUrl();
  window.location.replace(resolveLoginUrl());
}

/**
 * Full-screen blocking overlay shown when an authenticated user is NOT allowed
 * in the customer app (e.g. an artisan account). Prevents any protected page
 * content from flashing behind it, signs the wrong-role user out, and forwards
 * them to the application they belong to. Self-contained (no page CSS deps) so
 * it works identically on every customer page.
 */
function showRoleDenied({ title, message, buttonLabel, buttonHref }) {
  try {
    let overlay = document.getElementById(DENY_OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = DENY_OVERLAY_ID;
      overlay.setAttribute('role', 'alertdialog');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:#FEFEFE', 'padding:24px',
        'font-family:-apple-system,BlinkMacSystemFont,"DM Sans",sans-serif',
      ].join(';');
      document.body.appendChild(overlay);
    }
    overlay.innerHTML =
      '<div style="text-align:center;max-width:360px;width:100%;">' +
        '<div style="width:72px;height:72px;border-radius:22px;margin:0 auto 20px;background:#F3F4F6;' +
          'display:flex;align-items:center;justify-content:center;">' +
          '<svg width="32" height="32" viewBox="0 0 24 24" fill="none">' +
            '<rect x="3" y="11" width="18" height="11" rx="2" stroke="#9CA3AF" stroke-width="2"/>' +
            '<path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/>' +
          '</svg>' +
        '</div>' +
        '<p style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;">' + title + '</p>' +
        '<p style="font-size:14px;color:#6B7280;line-height:1.55;margin:0 0 24px;">' + message + '</p>' +
        '<button id="hh-role-deny-btn" style="width:100%;height:50px;border:none;border-radius:14px;' +
          'font:inherit;font-size:15px;font-weight:700;cursor:pointer;background:#8B1E3F;color:#fff;">' +
          buttonLabel +
        '</button>' +
      '</div>';
    const btn = document.getElementById('hh-role-deny-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          const { services } = getAppContainer();
          if (services.sessionService) await services.sessionService.logout();
          else if (services.authService?.signOut) await services.authService.signOut();
        } catch (_) { /* ignore */ }
        window.location.replace(buttonHref);
      });
    }
  } catch (_) {
    // If DOM injection fails for any reason, fall back to a hard redirect so the
    // wrong-role user is never left sitting on a protected page.
    window.location.replace(buttonHref);
  }
}

/**
 * The main auth guard — AUTHENTICATION + AUTHORIZATION (application boundary).
 *
 * Order of checks:
 *   1. Firebase authentication — a signed-in user must exist.
 *   2. Role authorization      — the user's authoritative role (resolveAppRole)
 *                                must be CUSTOMER. An artisan is blocked with a
 *                                "wrong app" screen; authentication alone never
 *                                grants entry.
 *
 * Returns a Promise that resolves with the Firebase user ONLY for an authorized
 * customer; otherwise it redirects / shows a denial overlay and never resolves.
 *
 * @returns {Promise<object>} Resolves with the current Firebase user object.
 */
export async function requireAuth() {
  return new Promise((resolve) => {
    // ── Slowness is NOT a logout ────────────────────────────────────────────
    //
    // This used to redirect to login when Firebase had not answered within N
    // seconds. That is the bug behind "it logged me out on bad internet": a cold
    // start on 2G, a backgrounded tab, or a slow gstatic fetch all tripped it
    // while the session was perfectly valid. The threshold had already been
    // raised 3s → 6s for exactly this reason, which treated the symptom.
    //
    // Firebase Auth restores a session from local persistence WITHOUT network —
    // onAuthStateChanged fires with the cached user even offline. So a slow
    // resolve means "the SDK is still starting", never "this person is signed
    // out". Waiting is safe; redirecting is not.
    //
    // The only signal that legitimately ends a session is Firebase itself
    // reporting a null user, which is handled below.
    const hadSession = (() => {
      try { return Boolean(localStorage.getItem('hh_last_session_uid')); }
      catch { return false; }
    })();

    // Reassure rather than redirect. On a device that has signed in before we
    // wait indefinitely; on a device with no prior session we still fall back to
    // login, because there is genuinely nothing to restore.
    const timeout = setTimeout(() => {
      if (hadSession) {
        showAuthWaiting();
      } else {
        redirectToLogin();
      }
    }, AUTH_GUARD_TIMEOUT_MS);

    const container = getAppContainer();

    container.services.authService.waitForUser()
      .then(async (user) => {
        clearTimeout(timeout);
        hideAuthWaiting();

        // ── Step 1: authentication ────────────────────────────────
        if (!user) {
          redirectToLogin();
          return;
        }

        // ── Step 2: role authorization (application boundary) ──────
        // Authentication proves identity, not permission. Verify this UID is a
        // customer before any protected page state initializes.
        let roleInfo = null;
        try {
          roleInfo = await resolveAppRole(container.services.databaseService, user.uid);
        } catch (_) {
          roleInfo = null;
        }

        // Positively an artisan → hard deny (the reported vulnerability). This
        // also catches legacy hybrid accounts because artisan identity wins.
        if (roleInfo && roleInfo.isArtisan) {
          showRoleDenied({
            title: 'Wrong App',
            message: "You're signed in with an artisan account. Artisans use the HandyHub Pro app, not the Customer app.",
            buttonLabel: 'Go to Artisan App',
            buttonHref: ARTISAN_APP_URL,
          });
          return;
        }

        // Positively a customer → authorized.
        if (roleInfo && roleInfo.role === ROLE.CUSTOMER) {
          if (window.HH_State) window.HH_State.setUser(user.uid);
          resolve(user);
          return;
        }

        // Ambiguous: role reads failed entirely (readError). Degrade OPEN rather
        // than false-deny a legitimate customer on a flaky network — the server
        // (firestore.rules) remains the authoritative backstop for every read
        // and write, so a non-customer gains no data access here.
        if (!roleInfo || roleInfo.readError) {
          if (window.HH_State) window.HH_State.setUser(user.uid);
          resolve(user);
          return;
        }

        // Reads succeeded but the UID owns no customer identity (e.g. an admin,
        // or a brand-new account whose profile write hasn't landed yet). Send
        // them back to login rather than into a half-provisioned customer app.
        showRoleDenied({
          title: 'Account Not Found',
          message: 'We could not find a customer profile for this account. Please sign in with a customer account.',
          buttonLabel: 'Back to Login',
          buttonHref: resolveLoginUrl(),
        });
      })
      .catch(() => {
        clearTimeout(timeout);
        redirectToLogin();
      });
  });
}

/**
 * Read and consume the saved return URL (one-time use).
 * Called by login.html after a successful sign-in.
 *
 * @returns {string|null} The URL to redirect to, or null if none saved.
 */
export function consumeReturnUrl() {
  try {
    const url = sessionStorage.getItem(AUTH_REDIRECT_KEY);
    if (url) sessionStorage.removeItem(AUTH_REDIRECT_KEY);
    // Only honour same-origin URLs for security
    if (url && new URL(url).origin === window.location.origin) {
      return url;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/* ── Self-executing guard ────────────────────────────────────────────────
   When this file is loaded as a standalone <script type="module">, it
   automatically runs the guard without the importing page needing to call
   requireAuth() explicitly. Pages that import named exports can opt in
   to explicit calling instead.
─────────────────────────────────────────────────────────────────────── */
if (import.meta.url === document.currentScript?.src) {
  // Standalone mode — run automatically
  requireAuth().catch(() => {});
}
