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
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, setPersistence, browserLocalPersistence }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

/* ── Firebase project config ─────────────────────────────────────────────
 * Same Firebase PROJECT as the artisan/customer apps (lamax-4fd82).
 * The admin uses a separate named app ('handy-hub-admin') so its auth
 * session is stored in a different localStorage key — admins must log in
 * explicitly and are never auto-signed-in by the artisan/customer session.
 * ──────────────────────────────────────────────────────────────────────── */
export const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBF-B48cl2jHJwcKxocpClNTYlLwK1cLiw',
  authDomain:        'lamax-4fd82.firebaseapp.com',
  projectId:         'lamax-4fd82',
  storageBucket:     'lamax-4fd82.firebasestorage.app',
  messagingSenderId: '1034220501833',
  appId:             '1:1034220501833:web:bba9ad6f78881029a0f898',
};

/* ── Custom Firestore database ID ────────────────────────────────────────── */
export const ADMIN_DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

/* ── Named app — keeps admin session isolated from artisan/customer ────── */
const ADMIN_APP_NAME = 'handy-hub-admin';

/* ── Singleton: reuse existing named app on hot-module reloads ───────────── */
const adminApp =
  getApps().find(a => a.name === ADMIN_APP_NAME) ??
  initializeApp(FIREBASE_CONFIG, ADMIN_APP_NAME);

/* ── Exported service instances ──────────────────────────────────────────── */
export const auth    = getAuth(adminApp);
export const db      = getFirestore(adminApp, ADMIN_DB_ID);
export const storage = getStorage(adminApp);

/* ── Persist admin sessions across browser refreshes ────────────────────── */
setPersistence(auth, browserLocalPersistence).catch(() => {});
