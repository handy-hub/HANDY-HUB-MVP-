/**
 * devAccess.js — THE single switch for Artisan Development Access Mode.
 *
 * This is a TEMPORARY development aid. It lets the Artisan App shell be built and
 * navigated without completing real Firebase login + onboarding — WITHOUT deleting,
 * weakening, or bypassing the real authentication, onboarding, role, or approval
 * systems. Those run verbatim the moment this flag is off.
 *
 * There is exactly ONE flag and ONE production fail-safe. Nothing else in the app
 * decides whether the bypass is active — every consumer calls
 * isArtisanDevAccessEnabled().
 *
 * TO DISABLE COMPLETELY (production): set ARTISAN_DEV_ACCESS = false below.
 * Even when true, the bypass is force-disabled on any production host (see
 * isProductionEnvironment) — it fails CLOSED, so a stray `true` can never ship a
 * backdoor to real users.
 *
 * See docs/ARTISAN_DEV_ACCESS.md.
 */

// ── THE FLAG ────────────────────────────────────────────────────────────────
export const ARTISAN_DEV_ACCESS = true;

// Hosts where the bypass is NEVER permitted, regardless of the flag.
const PRODUCTION_HOSTS = [
    'lamax-artisan.web.app',
    'lamax-4fd82.web.app',
    'lamax-4fd82.firebaseapp.com',
];

/**
 * True on any environment that must be treated as production. Fails CLOSED:
 * anything that isn't unmistakably local development is treated as production,
 * and any error resolves to "production" so the bypass can never accidentally
 * activate where it shouldn't.
 */
/** Pure, testable core: is this host/protocol a production environment? */
export function hostIsProduction(host = '', protocol = '') {
    host = String(host || '').toLowerCase();
    if (PRODUCTION_HOSTS.includes(host)) return true;
    const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '' ||                 // file:// has empty hostname
        protocol === 'file:' ||
        host.endsWith('.local') ||
        /^192\.168\./.test(host) ||    // LAN dev on a phone
        /^10\./.test(host);
    return !isLocal;
}

export function isProductionEnvironment() {
    try {
        return hostIsProduction(location.hostname, location.protocol);
    } catch {
        return true;   // no location / sandboxed → assume production
    }
}

/**
 * Is the emulator suite in use? Read directly from the same storage key
 * firebaseConfig.js sets, rather than importing it — devAccess is consumed by
 * modules that must not pull in the whole Firebase stack.
 */
function emulatorModeActive() {
    try {
        if (typeof location === 'undefined') return false;
        if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return false;
        if (new URLSearchParams(location.search).get('emulator') === '1') return true;
        return localStorage.getItem('hh_use_emulator') === '1';
    } catch { return false; }
}

/**
 * The ONE predicate every consumer uses.
 *
 * EMULATOR MODE WINS. The dev bypass exists because there was no way to sign in
 * locally — App Check refused Firestore from localhost, so the artisan app
 * handed out a mock session instead. The emulators removed that constraint, and
 * a mock session is now strictly worse than the real thing: its uid matches no
 * Firestore document and leaves Firebase Auth with no user at all, so every
 * read is denied by rules and screens sit on their skeletons forever.
 *
 * Both flags are localhost-only, so this cannot change production behaviour —
 * it only decides which of two local modes is in force, and a real signed-in
 * user against real rules is always the better test.
 */
export function isArtisanDevAccessEnabled() {
    if (emulatorModeActive()) return false;
    return ARTISAN_DEV_ACCESS === true && !isProductionEnvironment();
}
