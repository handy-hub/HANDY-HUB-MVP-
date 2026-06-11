import { initializeApp }                            from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth }                                   from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore }                              from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage }                                from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getMessaging }                              from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";
import { initializeAppCheck, ReCaptchaV3Provider }   from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { APP_CHECK_SITE_KEY }                        from "../../../config/appConfig.js";

// Firebase stays isolated in this folder so backend migration only touches provider code.
const firebaseConfig = {
  apiKey:            "AIzaSyBF-B48cl2jHJwcKxocpClNTYlLwK1cLiw",
  authDomain:        "lamax-4fd82.firebaseapp.com",
  projectId:         "lamax-4fd82",
  storageBucket:     "lamax-4fd82.firebasestorage.app",
  messagingSenderId: "1034220501833",
  appId:             "1:1034220501833:web:bba9ad6f78881029a0f898",
};

export const firestoreDatabaseId = "ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6";
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

