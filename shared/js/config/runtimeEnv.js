/**
 * runtimeEnv.js — is this code running inside a packaged native app?
 *
 * WHY THIS EXISTS
 * ───────────────
 * Several security gates in this codebase define "developer machine" as
 * `location.hostname === 'localhost'`:
 *
 *   devAccess.js        the artisan auth bypass
 *   firebaseConfig.js   App Check debug mode, Firestore emulator mode
 *
 * That was sound while the only things served from localhost were a developer's
 * `serve .` and the emulator suite. It stops being sound the moment the app is
 * packaged: Capacitor serves from `capacitor://localhost` on iOS and
 * `http://localhost` on Android, so a real user's phone satisfies every one of
 * those hostname checks.
 *
 * The consequence was not theoretical. With `ARTISAN_DEV_ACCESS = true`, a
 * packaged artisan app would have had `isProductionEnvironment()` return false
 * and handed out the auth bypass to real users — and App Check would have
 * entered debug mode, in a shipped binary.
 *
 * This module is the one place that answers "am I in a native shell?", so the
 * gates agree with each other and there is a single thing to correct if the
 * detection ever needs to change.
 *
 * DELIBERATELY NOT A BUILD FLAG
 * ─────────────────────────────
 * `appConfig.IS_PRODUCTION` is hardcoded `true` and is about which *backend*
 * this build points at — it is true on a developer's laptop too. Gating the dev
 * affordances on it would break local development and the emulator E2E suite.
 * The question here is different and orthogonal: not "which environment do I
 * talk to" but "am I inside a WebView I cannot trust to be a developer's own
 * browser". Keep them separate.
 */

/**
 * True when running inside a Capacitor (or equivalent) native shell.
 *
 * Fails CLOSED in the sense that matters: every check below can only ever turn
 * a dev affordance OFF. A false negative degrades to the previous behaviour; a
 * false positive merely disables a bypass that should not be relied on anyway.
 *
 * @returns {boolean}
 */
export function isNativeShell() {
    if (typeof window === 'undefined') return false;

    try {
        // Capacitor injects this global before any application code runs, on
        // both platforms. It is the most reliable signal and the only one that
        // works on Android, where the origin is an ordinary http://localhost.
        if (window.Capacitor) return true;

        // iOS serves the bundle from capacitor://localhost. Cordova, if it ever
        // appears here, uses file:// — which devAccess already treats as
        // non-local, but include it so this function is not subtly narrower.
        if (typeof location !== 'undefined') {
            const p = String(location.protocol || '').toLowerCase();
            if (p === 'capacitor:' || p === 'ionic:' || p === 'file:') return true;
        }
    } catch (_) {
        // A sandboxed or unusual context cannot be shown to be a browser, so
        // treat it as native — the conservative direction.
        return true;
    }

    return false;
}
