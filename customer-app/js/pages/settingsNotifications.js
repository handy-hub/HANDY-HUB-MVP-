import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
import { initializePushNotifications, enablePushNotifications, getPushState } from "../../../shared/js/services/pushNotificationService.js";
const DEFAULTS = { bookings: true, messages: true, offers: true, payments: true, reviews: true, system: true };
const KEYS = Object.keys(DEFAULTS);

let currentUser = null;
let prefs = { ...DEFAULTS };

function applyPrefs(data) {
    prefs = { ...DEFAULTS, ...(data?.notificationPreferences || {}) };
    KEYS.forEach((k) => {
        const el = document.getElementById(`toggle-${k}`);
        if (el) el.checked = prefs[k] !== false;
    });
}

let unsubscribe = null;

const { services: { authService, databaseService } } = getAppContainer();

authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
    // Read this device's real permission state without ever prompting.
    initializePushNotifications(user.uid, 'customer', { prompt: false }).finally(renderDeviceState);

    if (unsubscribe) unsubscribe();
    unsubscribe = databaseService.subscribeToDocument('customers', user.uid, (snap) => {
        applyPrefs(snap.exists ? snap.data : {});
    }, (err) => {
        console.warn('[settingsNotifications] listener error:', err);
    });
});

window.saveToggle = async function (key, value) {
    if (!currentUser) return;
    prefs[key] = value;
    try {
        await databaseService.setDocument('customers', currentUser.uid, {
            notificationPreferences: { ...prefs },
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (err) {
        console.error('Save notification pref error:', err);
        showToast('Could not save preference.', 'error');
        const el = document.getElementById(`toggle-${key}`);
        if (el) el.checked = !value;
        prefs[key] = !value;
    }
};

window.addEventListener('pagehide', () => { if (unsubscribe) unsubscribe(); });

// ── This device: what Android allows, and the one fix available from here ────
// The state comes from the OS (pushNotificationService → the plugin's
// checkPermissions), never from a remembered flag, so a change made in Android
// Settings shows up when the customer comes back to this screen.
const DEVICE_TEXT = {
    on:          'On. Booking updates reach you even when the app is closed.',
    off:         'Off on this device.',
    blocked:     'Blocked for Fidus X. To turn them on, open your phone’s Settings → Apps → Fidus X → Notifications.',
    failed:      'Could not be set up on this device. Try again.',
    unsupported: 'This device can’t receive push notifications. Updates still appear in the app.',
    pending:     'Checking this device…',
};
function renderDeviceState() {
    const state = getPushState();
    const line = document.getElementById('push-device-state');
    const btn  = document.getElementById('push-device-btn');
    if (line) line.textContent = DEVICE_TEXT[state] || DEVICE_TEXT.pending;
    if (btn)  btn.hidden = !(state === 'off' || state === 'failed');
}
window.addEventListener('fx:push-state', renderDeviceState);
document.getElementById('push-device-btn')?.addEventListener('click', async (e) => {
    if (!currentUser) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await enablePushNotifications(currentUser.uid, 'customer'); }
    finally { btn.disabled = false; renderDeviceState(); }
});
