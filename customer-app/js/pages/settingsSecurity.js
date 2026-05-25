import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
const currentPwEl  = document.getElementById('current-pw');
const newPwEl      = document.getElementById('new-pw');
const confirmPwEl  = document.getElementById('confirm-pw');
const saveBtn      = document.getElementById('save-btn');
const accountEmail = document.getElementById('account-email');

let currentUser = null;

const { services: { authService } } = getAppContainer();

authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
    if (accountEmail) accountEmail.textContent = user.email || '';
});

window.changePassword = async function () {
    if (!currentUser) return;

    const currentPw = currentPwEl?.value || '';
    const newPw     = newPwEl?.value     || '';
    const confirmPw = confirmPwEl?.value || '';

    if (!currentPw) { showToast('Enter your current password.', 'error'); currentPwEl?.focus(); return; }
    if (newPw.length < 8) { showToast('New password must be at least 8 characters.', 'error'); newPwEl?.focus(); return; }
    if (newPw !== confirmPw) { showToast('New passwords do not match.', 'error'); confirmPwEl?.focus(); return; }
    if (newPw === currentPw) { showToast('New password must differ from the current one.', 'error'); return; }

    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    saveBtn.textContent = 'Updating…';

    try {
        await authService.reauthenticateWithPassword(currentPw);
        await authService.changePassword(newPw);

        showToast('Password updated successfully!', 'success');
        if (currentPwEl)  currentPwEl.value  = '';
        if (newPwEl)      newPwEl.value      = '';
        if (confirmPwEl)  confirmPwEl.value  = '';
    } catch (err) {
        console.error('Change password error:', err);
        const msg = err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
            ? 'Current password is incorrect.'
            : err.code === 'auth/weak-password'
            ? 'Password is too weak. Use at least 8 characters.'
            : 'Failed to update password. Please try again.';
        showToast(msg, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.classList.remove('loading');
        saveBtn.textContent = 'Update Password';
    }
};

