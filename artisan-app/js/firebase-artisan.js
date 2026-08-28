/**
 * firebase-artisan.js
 *
 * The artisan app's Firebase handles — now DELEGATED to the one shared
 * initialisation rather than built alongside it.
 *
 * WHY THIS CHANGED
 * ────────────────
 * This module used to call getAuth()/getFirestore()/getStorage() itself. Those
 * are cached per app, so it got the same objects the customer app uses — but
 * only ever the *objects*. Everything firebaseConfig.js DOES around them at
 * import time was skipped on any page that never imported it, and no artisan
 * page did:
 *
 *   • App Check is initialised there, deliberately BEFORE any product requests
 *     credentials. Creating auth/db first inverts that documented ordering.
 *   • Emulator wiring lives there. Because this module bypassed it, the entire
 *     artisan app kept talking to the REAL project during local emulator runs —
 *     artisan sign-in returned HTTP 400 while the customer app worked fine, and
 *     the page reported it as "Incorrect email or password", which was a lie.
 *   • Auth persistence is configured there with an indexedDB→localStorage
 *     fallback; here it was localStorage only.
 *
 * Two initialisation paths for one Firebase app is the same split-brain the
 * booking rebuild removed from routing, transitions and Cloud Functions
 * instances. This is that fix applied to the foundation.
 *
 * The exported names are unchanged, so every existing
 * `import { auth, db } from './js/firebase-artisan.js'` keeps working.
 */

import {
  firebaseApp,
  firebaseAuth,
  firebaseDb,
  firebaseStorage,
  firestoreDatabaseId,
  usingEmulators,
} from '../../shared/js/backend/providers/firebase/firebaseConfig.js';

export const ARTISAN_DB_ID = firestoreDatabaseId;

export const app     = firebaseApp;
export const auth    = firebaseAuth;
export const db      = firebaseDb;
export const storage = firebaseStorage;

/** Exposed so artisan screens can tell a local emulator run from the real thing. */
export { usingEmulators };
