/**
 * auth-guard.js
 *
 * Shared admin authentication and session management.
 * Imported by every admin page.
 *
 * Usage:
 *   import { initAdminPage, signOutAdmin, requireAdmin } from './js/auth-guard.js';
 *
 *   // Protect a page and receive the verified admin user:
 *   initAdminPage(user => {
 *     // page init code here — only runs when auth is confirmed
 *   });
 *
 *   window.signOut = signOutAdmin;
 */

import { auth, db } from './firebase-admin.js';
import {
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { doc, getDoc }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { SUPER_ADMIN_EMAILS }
  from '../../shared/js/config/appConfig.js';

// Re-export so callers that import from this file continue to work unchanged.
export { SUPER_ADMIN_EMAILS };

/* ── Ensure sessions survive page refreshes ──────────────────────────────── */
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ─────────────────────────────────────────────────────────────────────────
 * initAdminPage(onReady)
 *
 * Sets up an onAuthStateChanged listener for the current page.
 * - Redirects to login.html if not signed-in or not an admin.
 * - Calls onReady(user) once the user is verified.
 * - Returns the unsubscribe function if you need to clean up.
 * ───────────────────────────────────────────────────────────────────────── */
export function initAdminPage(onReady) {
  const unsubscribe = onAuthStateChanged(auth, async user => {
    if (!user) {
      _redirectToLogin();
      return;
    }

    /* 1. Fast check: is the email in the hard-coded list? */
    if (SUPER_ADMIN_EMAILS.includes(user.email)) {
      _populateAdminUI(user);
      onReady(user);
      return;
    }

    /* 2. Fallback: check Firestore admins collection */
    try {
      const snap = await getDoc(doc(db, 'admins', user.uid));
      if (snap.exists() && snap.data().status === 'active') {
        _populateAdminUI(user);
        onReady(user);
      } else {
        _redirectToLogin();
      }
    } catch {
      /* Network error — if we can't verify, deny access */
      _redirectToLogin();
    }
  });

  return unsubscribe;
}

/* ─────────────────────────────────────────────────────────────────────────
 * requireAdmin(user)
 *
 * Synchronous check you can use inside Cloud Functions calls or wherever
 * you already have the user object.
 * ───────────────────────────────────────────────────────────────────────── */
export function isAdminEmail(email) {
  return SUPER_ADMIN_EMAILS.includes(email);
}

/* ─────────────────────────────────────────────────────────────────────────
 * signOutAdmin()
 *
 * Signs out and redirects to the admin login page.
 * Assign to window.signOut so sidebar button works:
 *   window.signOut = signOutAdmin;
 * ───────────────────────────────────────────────────────────────────────── */
export async function signOutAdmin() {
  try {
    await signOut(auth);
  } catch { /* ignore */ }
  _redirectToLogin();
}

/* ── Internal helpers ─────────────────────────────────────────────────── */
function _redirectToLogin() {
  const here = window.location.pathname;
  if (!here.endsWith('login.html')) {
    window.location.href = 'login.html';
  }
}

function _populateAdminUI(user) {
  const name = user.displayName || user.email.split('@')[0];
  const el   = id => document.getElementById(id);
  if (el('admin-name'))   el('admin-name').textContent   = name;
  if (el('admin-avatar')) el('admin-avatar').textContent = name.charAt(0).toUpperCase();
  if (el('admin-role'))   el('admin-role').textContent   =
    SUPER_ADMIN_EMAILS.includes(user.email) ? 'Super Admin' : 'Admin';
}
