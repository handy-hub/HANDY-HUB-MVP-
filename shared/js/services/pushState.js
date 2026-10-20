/**
 * pushState.js — what this device's push status is, and what it means.
 *
 * Pure (no imports), so pushNotificationService.js, the artisan dashboard's
 * job-alert banner and tests/push-delivery.test.cjs all read the same rules.
 *
 * A successful service-worker registration is NOT "push works": only a token
 * that was obtained AND saved counts as ON. Everything short of that is stated
 * plainly to the artisan, because a job offer expires within minutes and the
 * dashboard is then the only place it can be seen.
 */

export const PUSH_STATE = Object.freeze({
    PENDING:     'pending',      // still being set up
    ON:          'on',           // token obtained and saved — pushes can arrive
    OFF:         'off',          // permission not asked yet
    BLOCKED:     'blocked',      // permission denied in this browser
    FAILED:      'failed',       // permission granted, but registration or token failed
    UNSUPPORTED: 'unsupported',  // this browser cannot receive web push
});

/**
 * Banner copy for a state. `alert` = whether to show it at all, `canEnable` =
 * whether a button can fix it from here (a denied permission cannot be
 * re-prompted; only the browser's settings can lift it).
 */
export function describePushState(state) {
    switch (state) {
        case PUSH_STATE.OFF:
            return { state, alert: true, canEnable: true,
                message: 'Job alerts are off on this device. Offers expire within minutes — turn alerts on so you hear about new jobs.' };
        case PUSH_STATE.BLOCKED:
            return { state, alert: true, canEnable: false,
                message: 'Notifications are blocked for this site. Allow them in your browser settings, or keep this screen open — new offers appear here and expire within minutes.' };
        case PUSH_STATE.FAILED:
            return { state, alert: true, canEnable: true,
                message: 'Job alerts could not be set up on this device. Keep this screen open to see new offers, or try again.' };
        case PUSH_STATE.UNSUPPORTED:
            return { state, alert: true, canEnable: false,
                message: 'This browser cannot receive job alerts. Keep this screen open — new offers appear here and expire within minutes.' };
        default:   // ON, PENDING
            return { state, alert: false, canEnable: false, message: '' };
    }
}

/** A token is written only when it is new: every write re-indexes the artisan. */
export function tokenNeedsSave(savedToken, token) {
    return typeof token === 'string' && token.length > 0 && token !== savedToken;
}

/**
 * The root service worker's URL. The worker (shared/push/firebase-messaging-sw.js)
 * reads these parameters: which app's pages to open, and the page's own
 * Firebase config, so there is one config per environment and no copy of it
 * inside the worker.
 */
export function workerUrl(userType, options = {}) {
    const q = new URLSearchParams({
        app:               userType === 'artisan' ? 'artisan' : 'customer',
        apiKey:            String(options.apiKey || ''),
        projectId:         String(options.projectId || ''),
        messagingSenderId: String(options.messagingSenderId || ''),
        appId:             String(options.appId || ''),
    });
    return `/firebase-messaging-sw.js?${q.toString()}`;
}
