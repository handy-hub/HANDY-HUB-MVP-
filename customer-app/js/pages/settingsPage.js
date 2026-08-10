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
const _unsubAuth = authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
});
window.addEventListener('pagehide', () => { if (_unsubAuth) _unsubAuth(); }, { once: true });

// ── Delete account ────────────────────────────────────────────────────────────
window.confirmDeleteAccount = async function () {
    if (!currentUser) return;

    const password = document.getElementById('delete-password').value;
    if (!password) { showToast('Please enter your password.', 'error'); return; }

    const btn = document.getElementById('delete-confirm-btn');
    btn.disabled    = true;
    btn.textContent = 'Deleting…';

    try {
        // ── 1. Prove identity (password re-auth), but do NOT delete here ──────
        // The old code called authService.deleteAccount(password), which destroyed
        // the Firebase Auth user client-side. That orphaned any wallet balance,
        // held escrow, and all PII, because nothing on the server ever cleaned up
        // and the user could never sign in again to reach their money (CX-1).
        // Re-auth now only PROVES who we are; the server owns the teardown.
        await authService.reauthenticateWithPassword(password);

        // ── 2. Server-authoritative, guarded deletion ─────────────────────────
        // requestAccountDeletion refuses while the user still holds money or has
        // an active booking, then anonymizes the profile and deletes the Auth user
        // in a safe order (Firestore first, Auth last).
        await deleteAccountOnServer();

        // Auth user is gone; clear any local session remnants and leave.
        try { await authService.signOut(); } catch (_) { /* already gone */ }
        window.location.href = 'login.html';

    } catch (err) {
        console.error('Delete account error:', err);

        let msg;
        if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
            msg = 'Incorrect password. Please try again.';
        } else if (err.code === 'functions/failed-precondition') {
            // The server refused because money or obligations are outstanding.
            // Its message is already user-facing and actionable
            // ("Withdraw your GHS 50.00 balance before deleting your account.").
            msg = err.message || 'Your account cannot be deleted yet.';
        } else {
            msg = 'Failed to delete account. Please try again.';
        }
        showToast(msg, 'error');
        btn.disabled    = false;
        btn.textContent = 'Yes, Delete My Account';
    }
};

/** Call the guarded server-side deletion Cloud Function. */
async function deleteAccountOnServer() {
    const [{ getFunctions, httpsCallable }, { firebaseApp }, { FUNCTIONS_REGION }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js'),
        import('../../../shared/js/backend/providers/firebase/firebaseConfig.js'),
        import('../../../shared/js/config/appConfig.js'),
    ]);
    const fn = httpsCallable(getFunctions(firebaseApp, FUNCTIONS_REGION), 'requestAccountDeletion');
    await fn({});
}
