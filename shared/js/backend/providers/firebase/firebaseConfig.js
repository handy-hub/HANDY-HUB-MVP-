import { getApp, getApps, initializeApp } from "../../../../vendor/firebase/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, indexedDBLocalPersistence, connectAuthEmulator }
  from "../../../../vendor/firebase/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "../../../../vendor/firebase/firebase-firestore.js";
import { getStorage } from "../../../../vendor/firebase/firebase-storage.js";
import { getFunctions, connectFunctionsEmulator } from "../../../../vendor/firebase/firebase-functions.js";
import { getMessaging } from "../../../../vendor/firebase/firebase-messaging.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "../../../../vendor/firebase/firebase-app-check.js";import {
  APP_CHECK_SITE_KEY,
  FIREBASE_CONFIG as firebaseConfig,
  FIRESTORE_DB_ID,
  FUNCTIONS_REGION,
} from "../../../config/appConfig.js";
import { isNativeShell } from "../../../config/runtimeEnv.js";

export const firestoreDatabaseId = FIRESTORE_DB_ID;
export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

function appCheckDebugWasExplicitlyEnabled() {
  if (typeof location === "undefined") return false;
  // A packaged app serves from localhost, so the hostname test below would put
  // a shipped binary into App Check debug mode.
  if (isNativeShell()) return false;
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return false;
  // Hostname is the explicit development boundary. Production/custom/Firebase
  // Hosting domains can never enter debug mode through client storage.
  // A local developer may opt out temporarily for real-provider diagnostics.
  try { return localStorage.getItem("hh_app_check_debug") !== "0"; }
  catch { return true; }
}

const localDebugEnabled = appCheckDebugWasExplicitlyEnabled();

/**
 * LOCAL EMULATOR MODE — opt-in, localhost-only, fail-closed.
 *
 * App Check refuses Firestore from localhost against the real project, which
 * meant the booking lifecycle could not be exercised end-to-end anywhere except
 * production. That is the precise condition CLAUDE.md §5 warns about: this
 * project has repeatedly shipped green commands over broken systems because
 * nothing could actually be run before deploying.
 *
 * Pointing the apps at the Firestore + Auth emulators removes App Check from
 * the path entirely and gives a real, seedable, throwaway backend.
 *
 * Two independent conditions, both required — same shape as the App Check debug
 * gate above, so a stray flag can never reach a real user:
 *   1. hostname is localhost or 127.0.0.1
 *   2. explicit opt-in: ?emulator=1 in the URL, or localStorage hh_use_emulator="1"
 *
 * The URL form sets the localStorage flag so it survives in-app navigation
 * (this is a multi-page app — every link is a fresh document load).
 */
function emulatorModeEnabled() {
  if (typeof location === "undefined") return false;
  // Same hazard: a packaged app must never try to reach Firestore/Auth
  // emulators on the handset itself.
  if (isNativeShell()) return false;
  if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return false;
  try {
    const q = new URLSearchParams(location.search).get("emulator");
    if (q === "1") { localStorage.setItem("hh_use_emulator", "1"); return true; }
    if (q === "0") { localStorage.removeItem("hh_use_emulator"); return false; }
    return localStorage.getItem("hh_use_emulator") === "1";
  } catch { return false; }
}

export const usingEmulators = emulatorModeEnabled();

// App Check must be created before any Firebase product requests credentials.
// Debug mode is opt-in, localhost-only, and generates its token at runtime.
if (APP_CHECK_SITE_KEY && localDebugEnabled) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

// The emulators do not enforce App Check, and initialising the reCAPTCHA
// provider against a local origin only produces noise.
export const firebaseAppCheck = (APP_CHECK_SITE_KEY && !usingEmulators)
  ? initializeAppCheck(firebaseApp, {
       provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
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

if (usingEmulators) {
  try {
    connectAuthEmulator(firebaseAuth, "http://127.0.0.1:9099", { disableWarnings: true });
  } catch (e) {
    console.warn("[firebase:emulator] auth connect failed:", e?.message || e);
  }
}

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

if (usingEmulators) {
  try {
    // The named database is preserved — the emulator serves arbitrary database
    // ids, and using the real one keeps trigger/config parity with production.
    connectFirestoreEmulator(firebaseDb, "127.0.0.1", 8080);
    console.warn("[firebase:emulator] ACTIVE — Firestore 8080, Auth 9099, db=" + firestoreDatabaseId +
                 ". No production data is being touched.");
  } catch (e) {
    console.warn("[firebase:emulator] firestore connect failed:", e?.message || e);
  }
}
export const firebaseStorage = getStorage(firebaseApp);

/**
 * THE Cloud Functions instance.
 *
 * Twelve modules each built their own with getFunctions(firebaseApp, REGION).
 * Twelve instances is not a correctness bug in production — they resolve to the
 * same endpoint — but it means there are twelve places that must each be told
 * about the emulator, and any one of them missed silently calls PRODUCTION from
 * a local test. That is precisely the kind of split-brain the booking rebuild
 * has been removing everywhere else, so it gets the same treatment: one
 * instance, connected once, imported by everyone.
 */
export const firebaseFunctions = getFunctions(firebaseApp, FUNCTIONS_REGION);

if (usingEmulators) {
  try {
    connectFunctionsEmulator(firebaseFunctions, "127.0.0.1", 5001);
  } catch (e) {
    console.warn("[firebase:emulator] functions connect failed:", e?.message || e);
  }
}

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
