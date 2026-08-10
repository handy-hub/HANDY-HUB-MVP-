import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
import { openSecurityPinSheet } from "../../../shared/js/components/securityPinSheet.js";
import { setSecurityPin, pinErrorMessage } from "../../../shared/js/services/securityPinService.js";
const currentPwEl  = document.getElementById('current-pw');
const newPwEl      = document.getElementById('new-pw');
const confirmPwEl  = document.getElementById('confirm-pw');
const saveBtn      = document.getElementById('save-btn');
const accountEmail = document.getElementById('account-email');

let currentUser = null;

const { services: { authService, databaseService } } = getAppContainer();

authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
    if (accountEmail) accountEmail.textContent = user.email || '';
    loadPinStatus(user.uid);
});

// ── Security PIN section ──────────────────────────────────────────────────────
// Renders PIN status + actions from SAFE metadata on customers/{uid}
// (securityPinConfigured / securityPinUpdatedAt) — fields the backend writes
// when the PIN Cloud Functions ship. The PIN itself and its hash live in
// payment_security/{uid}, which no client can ever read. The rows below are the
// permanent navigation home for the credential; the Create/Change/Reset flows
// arrive in the next phase.

const pinStatusEl  = document.getElementById('pin-status');
const pinActionsEl = document.getElementById('pin-actions');

const PIN_CHEVRON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M9 18l6-6-6-6" stroke="#bbb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const PIN_ICONS = {
    create: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="14" r="4" stroke="currentColor" stroke-width="2"/><path d="M11 11l8-8M17 4l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    change: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="14" r="4" stroke="currentColor" stroke-width="2"/><path d="M11 11l8-8M17 4l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    reset:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 1 1-2.6-6.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 3v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function pinActionRow(action, title, sub) {
    return (
        `<button class="menu-item" type="button" data-pin-action="${action}">` +
        `<div class="menu-icon-wrap">${PIN_ICONS[action] || ''}</div>` +
        `<div class="menu-text"><p class="menu-title">${title}</p>` +
        (sub ? `<p class="menu-sub">${sub}</p>` : '') +
        `</div>${PIN_CHEVRON}</button>`
    );
}

function renderPinSection(configured, updatedAtIso) {
    if (!pinStatusEl || !pinActionsEl) return;

    if (configured) {
        let when = '';
        if (updatedAtIso) {
            const d = new Date(updatedAtIso);
            if (!Number.isNaN(d.getTime())) {
                when = ' · updated ' + d.toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' });
            }
        }
        pinStatusEl.textContent = 'Active' + when;
        pinActionsEl.innerHTML =
            pinActionRow('change', 'Change PIN', 'Requires your current PIN') +
            pinActionRow('reset',  'Reset PIN',  'Verify your identity to set a new PIN');
    } else {
        pinStatusEl.textContent = 'Not set — required for financial actions';
        pinActionsEl.innerHTML =
            pinActionRow('create', 'Create Security PIN', 'A 4-digit PIN for top-ups, withdrawals and payouts');
    }

    pinActionsEl.querySelectorAll('[data-pin-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.pinAction;
            if (action === 'create') { openCreatePinFlow(); return; }
            // Change and Reset require current-PIN / identity verification
            // endpoints that ship in the next phase — state their status
            // honestly rather than appearing functional.
            showToast('Change and Reset PIN arrive in the next update.', 'info');
        });
    });
}

// ── Create PIN — the same reusable sheet the top-up flow uses ─────────────────
function openCreatePinFlow() {
    if (!currentUser) return;
    openSecurityPinSheet({
        mode: 'create',
        onCreate: async (pin, controls) => {
            controls.setBusy(true);
            try {
                await setSecurityPin(pin);   // scrypt-hashed server-side; raw PIN never stored
                controls.close('created');
                showToast('Security PIN created.', 'success');
                loadPinStatus(currentUser.uid);   // re-render Active + actions
            } catch (err) {
                if (String(err?.code || '').includes('already-exists')) {
                    controls.close('created');
                    showToast(pinErrorMessage(err), 'info');
                    loadPinStatus(currentUser.uid);
                    return;
                }
                controls.showError(pinErrorMessage(err));
            }
        },
    });
}

async function loadPinStatus(uid) {
    if (!pinStatusEl) return;
    try {
        const snap = await databaseService.getDocument('customers', uid);
        const data = snap && snap.exists ? (snap.data || {}) : {};
        renderPinSection(
            Boolean(data.securityPinConfigured),
            data.securityPinUpdatedAt || data.securityPinCreatedAt || null
        );
    } catch (err) {
        console.warn('[security] PIN status load failed:', err);
        renderPinSection(false, null);
    }
}

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

