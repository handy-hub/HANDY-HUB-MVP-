import { initializeApp }                            from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth }                                   from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore }                              from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage }                                from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getMessaging }                              from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";
import { initializeAppCheck, ReCaptchaV3Provider }   from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { APP_CHECK_SITE_KEY, FIREBASE_CONFIG as firebaseConfig, FIRESTORE_DB_ID } from "../../../config/appConfig.js";

export const firestoreDatabaseId = FIRESTORE_DB_ID;
export const firebaseApp     = initializeApp(firebaseConfig);
export const firebaseAuth    = getAuth(firebaseApp);
export const firebaseDb      = getFirestore(firebaseApp, firestoreDatabaseId);
export const firebaseStorage = getStorage(firebaseApp);

// FCM Messaging — used by pushNotificationService.js for token registration.
// Gracefully skipped in environments where messaging isn't supported (Safari < 16, etc.).
export let firebaseMessaging = null;
try {
  firebaseMessaging = getMessaging(firebaseApp);
} catch (_) {}

// App Check — intercepts every Firebase SDK call and validates the request came from
// your real app, not a bot or scraper. Enforcement is toggled in Firebase Console.
// Skipped gracefully when APP_CHECK_SITE_KEY is not yet configured.
if (APP_CHECK_SITE_KEY) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}
