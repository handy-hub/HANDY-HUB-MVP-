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

/** The ONE predicate every consumer uses. */
export function isArtisanDevAccessEnabled() {
    return ARTISAN_DEV_ACCESS === true && !isProductionEnvironment();
}
