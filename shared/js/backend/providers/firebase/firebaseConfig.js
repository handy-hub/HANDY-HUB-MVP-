import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, indexedDBLocalPersistence }
  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getMessaging } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import {
  APP_CHECK_SITE_KEY,
  FIREBASE_CONFIG as firebaseConfig,
  FIRESTORE_DB_ID,
} from "../../../config/appConfig.js";

export const firestoreDatabaseId = FIRESTORE_DB_ID;
export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

function appCheckDebugWasExplicitlyEnabled() {
  if (typeof location === "undefined") return false;
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return false;
  // Hostname is the explicit development boundary. Production/custom/Firebase
  // Hosting domains can never enter debug mode through client storage.
  // A local developer may opt out temporarily for real-provider diagnostics.
  try { return localStorage.getItem("hh_app_check_debug") !== "0"; }
  catch { return true; }
}

const localDebugEnabled = appCheckDebugWasExplicitlyEnabled();

// App Check must be created before any Firebase product requests credentials.
// Debug mode is opt-in, localhost-only, and generates its token at runtime.
if (APP_CHECK_SITE_KEY && localDebugEnabled) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

export const firebaseAppCheck = APP_CHECK_SITE_KEY
  ? initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    })
  : null;

// Stable initialization boundary for consumers that need to await setup.
export const firebaseReady = Promise.resolve({
  app: firebaseApp,
  appCheck: firebaseAppCheck,
});

// Firebase products are instantiated only after App Check.
export const firebaseAuth = getAuth(firebaseApp);

// Persist the session across app restarts, EXPLICITLY.
//
// The SDK default is already local persistence, but relying on a default for
// something this consequential is how "it logged me out" bugs survive review.
// indexedDB is preferred (survives more aggressive storage eviction on mobile
// Safari/Android WebView); browserLocal is the fallback when indexedDB is
// unavailable, e.g. private browsing.
//
// Fire-and-forget on purpose: setPersistence resolves before any auth call is
// made in practice, and a failure here must not block app start-up — the SDK
// falls back to its default rather than losing the session.
setPersistence(firebaseAuth, indexedDBLocalPersistence)
  .catch(() => setPersistence(firebaseAuth, browserLocalPersistence))
  .catch((err) => console.warn("[firebase] persistence not set:", err?.message || err));
export const firebaseDb = getFirestore(firebaseApp, firestoreDatabaseId);
export const firebaseStorage = getStorage(firebaseApp);

export let firebaseMessaging = null;
try {
  firebaseMessaging = getMessaging(firebaseApp);
} catch (_) {
  // Messaging is optional in unsupported browsers.
}

if (typeof location !== "undefined"
    && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  console.info("[firebase:init]", {
    appCheck: firebaseAppCheck ? (localDebugEnabled ? "debug" : "recaptcha-v3") : "disabled",
    databaseId: firestoreDatabaseId,
    productsInitializedAfterAppCheck: true,
  });
}
