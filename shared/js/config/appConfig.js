/**
 * appConfig.js — Centralised application configuration
 *
 * PURPOSE
 * ───────
 * All environment-specific values live here and NOWHERE ELSE.
 * Pages and services import from this file; they never hardcode keys or URLs.
 *
 * MIGRATION PATH
 * ──────────────
 * When moving from Firebase to a custom backend, swap the values below and
 * update the provider mapping in backendProviderFactory.js — zero changes
 * required in any UI or service file.
 *
 * SECURITY NOTE
 * ─────────────
 * Firebase API keys and Paystack public keys are safe to ship in frontend
 * bundles — they are scoped by Firestore Security Rules and Paystack domain
 * allow-lists respectively. SECRET keys (Paystack secret, etc.) must NEVER
 * appear in any frontend file. They belong exclusively in Cloud Functions
 * environment variables (firebase functions:secrets:set PAYSTACK_SECRET_KEY).
 *
 * CHANGING ENVIRONMENTS
 * ─────────────────────
 * For staging vs production, create appConfig.staging.js and swap the import
 * in your build step. Do not use runtime if/else branching on environments in
 * frontend files — it leaks all keys to every environment.
 */

// ── Firebase project configuration ────────────────────────────────────────────
// Identical across artisan, customer, and admin apps (same Firebase project).
// Admin uses a separate named app ('handy-hub-admin') to isolate auth sessions.
export const FIREBASE_CONFIG = {
    apiKey:            'AIzaSyBF-B48cl2jHJwcKxocpClNTYlLwK1cLiw',
    authDomain:        'lamax-4fd82.firebaseapp.com',
    projectId:         'lamax-4fd82',
    storageBucket:     'lamax-4fd82.firebasestorage.app',
    messagingSenderId: '1034220501833',
    appId:             '1:1034220501833:web:bba9ad6f78881029a0f898',
};

// ── Custom Firestore database ID ───────────────────────────────────────────────
export const FIRESTORE_DB_ID = 'ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6';

// ── Paystack configuration ────────────────────────────────────────────────────
// Public key only — safe in frontend bundles.
// Secret key lives in Cloud Functions environment variables ONLY.
export const PAYSTACK_CONFIG = {
    publicKey: 'pk_test_de485c75259b4953fb05891cffe6980428c59e50',
    sdkUrl:    'https://js.paystack.co/v1/inline.js',
    // Switch to 'pk_live_...' and update sdkUrl for production.
};

// ── Platform business rules ───────────────────────────────────────────────────
// These must match Cloud Functions environment variables:
//   COMMISSION_RATE, MIN_WITHDRAWAL, MIN_TOPUP
// They are displayed in the UI only — actual enforcement is server-side.
export const PLATFORM_CONFIG = {
    commissionRate:   0.15,   // 15% — displayed in fee breakdowns
    minWithdrawalGHS: 5,      // GHS 5 — UI validation hint
    minTopupGHS:      1,      // GHS 1 — UI validation hint
    currency:         'GHS',
    currencySymbol:   'GHS',
};

// ── Cloud Functions region ────────────────────────────────────────────────────
// europe-west1 (Belgium) — ~90 ms from Ghana vs ~270 ms for us-central1.
export const FUNCTIONS_REGION = 'europe-west1';

// ── Super admin emails ────────────────────────────────────────────────────────
// Used in auth-guard.js and ui utils. Matches firestore.rules and Cloud Functions.
// To change admins: update here, redeploy Firestore rules, redeploy Cloud Functions.
export const SUPER_ADMIN_EMAILS = [
    'silas7korda@gmail.com',
    'clasceth4traders@gmail.com',
    'paakumisam@gmail.com',
];

// ── Ghana Mobile Money providers ──────────────────────────────────────────────
export const MOMO_PROVIDERS = {
    mtn: {
        label:    'MTN MoMo',
        name:     'MTN Mobile Money',
        prefixes: ['024', '054', '055', '059', '025', '053'],
        color:    '#FFCC00',
    },
    telecel: {
        label:    'Telecel Cash',
        name:     'Telecel Cash',
        prefixes: ['020', '050'],
        color:    '#E00000',
    },
    airteltigo: {
        label:    'AirtelTigo',
        name:     'AirtelTigo Money',
        prefixes: ['026', '056', '027', '057'],
        color:    '#003F7F',
    },
};

// ── Firebase App Check ────────────────────────────────────────────────────────
// Blocks bots, scrapers, and unauthenticated API abuse at the Firebase SDK level.
// Get your site key:
//   Firebase Console → Project Settings → App Check → Web → Register → reCAPTCHA v3
//   (also register the reCAPTCHA v3 key at https://www.google.com/recaptcha/admin)
export const APP_CHECK_SITE_KEY = '6LfivBctAAAAAMKNFt5TNiIi5j712EdpfaDJOWfb'; // FILL IN before deploying

// ── FCM Web Push VAPID Key ─────────────────────────────────────────────────────
// Required for browser push notifications via Firebase Cloud Messaging.
// Get your key:
//   Firebase Console → Project Settings → Cloud Messaging
//   → Web Push certificates → Generate key pair → copy the Key pair value
export const FCM_VAPID_KEY = 'BMVktgapROcLKvu50GzG5hvXWRF9-9K4U8bQtMWt4rYRfvGzlvFkHiwxQRN4t9fAPTPDS892pS31nNn2D2rdZQk'; // FILL IN before deploying

// ── App metadata ───────────────────────────────────────────────────────────────
export const APP_META = {
    name:    'HandyHub',
    version: '1.0.0-mvp',
    country: 'GH',
    locale:  'en-GH',
};
