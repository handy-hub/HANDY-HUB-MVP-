/**
 * firebase-artisan.js
 *
 * Single source of truth for all artisan app Firebase services.
 * Uses the SAME config and DEFAULT app name as the shared DI container
 * (shared/js/backend/providers/firebase/firebaseConfig.js) so that auth
 * sessions written on the login page are readable on every other page.
 *
 * Usage in any artisan page:
 *   import { auth, db, storage } from './js/firebase-artisan.js';
 */

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, setPersistence, browserLocalPersistence }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage }
  from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

/* ── Config — must match shared/js/backend/providers/firebase/firebaseConfig.js ── */
const ARTISAN_CONFIG = {
  apiKey:            'AIzaSyBF-B48cl2jHJwcKxocpClNTYlLwK1cLiw',
  authDomain:        'lamax-4fd82.firebaseapp.com',
  projectId:         'lamax-4fd82',
  storageBucket:     'lamax-4fd82.firebasestorage.app',
  messagingSenderId: '1034220501833',
  appId:             '1:1034220501833:web:bba9ad6f78881029a0f898',
};

export const ARTISAN_DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

/* ── Singleton — reuse [DEFAULT] app if DI container already created it ── */
const artisanApp = getApps().length > 0 ? getApp() : initializeApp(ARTISAN_CONFIG);

export const auth    = getAuth(artisanApp);
export const db      = getFirestore(artisanApp, ARTISAN_DB_ID);
export const storage = getStorage(artisanApp);

/* ── Persist sessions across page reloads / browser restarts ─────────── */
setPersistence(auth, browserLocalPersistence).catch(() => {});
