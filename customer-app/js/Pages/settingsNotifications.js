import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
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

    if (unsubscribe) unsubscribe();
    unsubscribe = databaseService.subscribeToDocument('customers', user.uid, (snap) => {
        applyPrefs(snap.exists ? snap.data : {});
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

