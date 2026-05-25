import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
let currentUser = null;

const { services: { authService, databaseService } } = getAppContainer();

authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
});

window.confirmDeleteAccount = async function () {
    if (!currentUser) return;

    const password = document.getElementById('delete-password').value;
    if (!password) { showToast('Please enter your password.', 'error'); return; }

    const btn = document.getElementById('delete-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting…';

    try {
        // Delete Firestore customer document first, then auth account
        await databaseService.deleteDocument('customers', currentUser.uid);
        await authService.deleteAccount(password);

        window.location.href = 'login.html';
    } catch (err) {
        console.error('Delete account error:', err);
        const msg = err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
            ? 'Incorrect password. Please try again.'
            : 'Failed to delete account. Please try again.';
        showToast(msg, 'error');
        btn.disabled = false;
        btn.textContent = 'Yes, Delete My Account';
    }
};

