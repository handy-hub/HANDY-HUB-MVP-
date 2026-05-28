import '../../../shared/js/utils/global-app.js';
import { getAppContainer } from '../../../shared/js/app/container.js';
import { showToast } from '../../../shared/js/components/toast.js';
import { initSettingsSync, saveAppPreference } from '../../../shared/js/utils/settingsSync.js';

let currentUser = null;

const { services: { authService, databaseService } } = getAppContainer();

// ── Realtime settings sync (theme / currency / language ↔ Firestore) ─────────
// Boots once; listens to the customer doc and mirrors appPreferences to
// localStorage + live UI whenever the server value changes (e.g. another device).
initSettingsSync(authService, databaseService);

// ── Expose pref-writer to the page's inline <script> ─────────────────────────
// The inline selectPref() calls window.__saveAppPref(key, value) after writing
// to localStorage so the change is also persisted to Firestore in realtime.
window.__saveAppPref = function (key, value) {
    saveAppPreference(key, value).catch((err) =>
        console.warn('[settings] Firestore sync failed:', err.message)
    );
};

// ── Auth guard ────────────────────────────────────────────────────────────────
authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
});

// ── Delete account ────────────────────────────────────────────────────────────
window.confirmDeleteAccount = async function () {
    if (!currentUser) return;

    const password = document.getElementById('delete-password').value;
    if (!password) { showToast('Please enter your password.', 'error'); return; }

    const btn = document.getElementById('delete-confirm-btn');
    btn.disabled    = true;
    btn.textContent = 'Deleting…';

    try {
        // 1. Delete the Firebase Auth account first (requires password re-auth).
        //    This revokes all sessions and prevents further sign-in.
        await authService.deleteAccount(password);

        // 2. Best-effort: soft-mark the Firestore profile as deleted for audit trails.
        //    Firestore rules only allow profile-field updates, so we update with
        //    a field that passes isSafeCustomerProfileUpdate (updatedAt) and rely
        //    on a backend cleanup job for full removal.  Failure here is non-fatal
        //    because the auth account is already gone — the doc is inaccessible.
        try {
            await databaseService.updateDocument('customers', currentUser.uid, {
                updatedAt: new Date().toISOString(),
            });
        } catch (_) { /* non-fatal */ }

        window.location.href = 'login.html';
    } catch (err) {
        console.error('Delete account error:', err);
        const msg =
            err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
                ? 'Incorrect password. Please try again.'
                : 'Failed to delete account. Please try again.';
        showToast(msg, 'error');
        btn.disabled    = false;
        btn.textContent = 'Yes, Delete My Account';
    }
};
