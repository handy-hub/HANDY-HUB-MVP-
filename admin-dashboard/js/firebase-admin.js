/**
 * firebase-admin.js
 *
 * Single source of truth for ALL admin dashboard Firebase services.
 * Imported by every admin page — initialised once (singleton pattern).
 *
 * Usage in any admin page:
 *   import { db, auth, storage } from './js/firebase-admin.js';
 */

import { initializeApp, getApps }
  from '../../shared/vendor/firebase/firebase-app.js';
import { getAuth, setPersistence, browserLocalPersistence }
  from '../../shared/vendor/firebase/firebase-auth.js';
import { getFirestore }
  from '../../shared/vendor/firebase/firebase-firestore.js';
import { getStorage }
  from '../../shared/vendor/firebase/firebase-storage.js';
import { getFunctions, httpsCallable }
  from '../../shared/vendor/firebase/firebase-functions.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider }
  from '../../shared/vendor/firebase/firebase-app-check.js';

// The ONE definition of the site key, shared with the customer and artisan
// apps. Not copied — a second copy is how the key and the App Check
// registration drifted apart in the first place.
import { APP_CHECK_SITE_KEY, FIREBASE_CONFIG, FIRESTORE_DB_ID, FUNCTIONS_REGION }
  from '../../shared/js/config/appConfig.js';

/* ── Firebase project config ─────────────────────────────────────────────
 * Same Firebase PROJECT as the artisan/customer apps (lamax-4fd82).
 * The admin uses a separate named app ('handy-hub-admin') so its auth
 * session is stored in a different localStorage key — admins must log in
 * explicitly and are never auto-signed-in by the artisan/customer session.
 * ──────────────────────────────────────────────────────────────────────── */
// The project config, database and region come from shared/js/config/appConfig.js
// — the one definition all three apps use (this file used to carry a copy).
export { FIREBASE_CONFIG };
export const ADMIN_DB_ID = FIRESTORE_DB_ID;

/* ── Named app — keeps admin session isolated from artisan/customer ────── */
const ADMIN_APP_NAME = 'handy-hub-admin';

/* ── Singleton: reuse existing named app on hot-module reloads ───────────── */
const existingAdminApp = getApps().find(a => a.name === ADMIN_APP_NAME);
const adminApp = existingAdminApp ?? initializeApp(FIREBASE_CONFIG, ADMIN_APP_NAME);

/* -- App Check ------------------------------------------------------------
 * MUST run before getAuth/getFirestore/getStorage/getFunctions below --
 * products created first would request credentials with no attestation.
 *
 * This app instance previously had no App Check at all, which meant enforcing
 * App Check on Firestore would have locked admins out of the dashboard while
 * the customer and artisan apps kept working.
 *
 * Guarded on existingAdminApp because initializeAppCheck throws if called
 * twice for the same app, which the singleton above makes possible.
 * ---------------------------------------------------------------------- */
if (!existingAdminApp && APP_CHECK_SITE_KEY) {
  // Local dev cannot solve a reCAPTCHA for a production domain, so the SDK
  // issues a debug token instead. Register it under
  // App Check -> Apps -> Manage debug tokens. Admin is a web-only surface, so
  // this hostname check is not the Capacitor origin hazard the same pattern
  // creates in the customer/artisan config.
  if (typeof location !== 'undefined' &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(adminApp, {
      provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    // Never let attestation setup break the dashboard.
    console.warn('[firebase-admin] App Check init failed:', err && err.message);
  }
}

/* ── Exported service instances ──────────────────────────────────────────── */
export const auth    = getAuth(adminApp);
export const db      = getFirestore(adminApp, ADMIN_DB_ID);
export const storage = getStorage(adminApp);
export const fns     = getFunctions(adminApp, FUNCTIONS_REGION);

/* ── Persist admin sessions across browser refreshes ────────────────────── */
setPersistence(auth, browserLocalPersistence).catch(() => {});

/**
 * callAdminFunction — thin wrapper so every admin page invokes Cloud
 * Functions the same way: `await callAdminFunction('resolveDispute', {...})`.
 * All admin-privileged business logic (approve/reject/suspend/ban artisans,
 * resolve disputes, cancel bookings) must go through this — never write
 * directly to Firestore for these actions from admin pages.
 */
export function callAdminFunction(name, payload = {}) {
  return httpsCallable(fns, name)(payload);
}
