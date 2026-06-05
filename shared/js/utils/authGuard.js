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
 * 4. A 3-second timeout ensures the guard never hangs a page load forever —
 *    on timeout it redirects to login as a safe fallback.
 *
 * The login page reads 'hh_auth_redirect' after a successful sign-in and
 * forwards the user to their originally intended destination.
 */

import { getAppContainer } from '../app/container.js';

const AUTH_REDIRECT_KEY = 'hh_auth_redirect';
const LOGIN_PAGE        = 'login.html';

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
 * The main auth guard.
 * Returns a Promise that resolves with the Firebase user if authenticated,
 * or redirects (and never resolves) if not.
 *
 * @returns {Promise<object>} Resolves with the current Firebase user object.
 */
export async function requireAuth() {
  return new Promise((resolve) => {
    // Hard timeout — if Firebase takes > 3s (e.g., cold-start, no network)
    // we redirect to login rather than leaving the page stuck.
    const timeout = setTimeout(() => {
      redirectToLogin();
    }, 3000);

    getAppContainer()
      .services.authService.waitForUser()
      .then((user) => {
        clearTimeout(timeout);
        if (user) {
          // Activate uid-scoped storage so all HH_State reads/writes are
          // isolated to this user. This runs on every protected page.
          if (window.HH_State) window.HH_State.setUser(user.uid);
          resolve(user);
        } else {
          redirectToLogin();
        }
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
