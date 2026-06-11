import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
const nameEl     = document.getElementById('fi-name');
const phoneEl    = document.getElementById('fi-phone');
const locationEl = document.getElementById('fi-location');
const bioEl      = document.getElementById('fi-bio');
const emailEl    = document.getElementById('fi-email');
const saveBtn    = document.getElementById('save-btn');
const bioCount   = document.getElementById('bio-count');

let currentUser = null;
let unsubscribe = null;

const { services: { authService, databaseService } } = getAppContainer();

authService.subscribeToAuthState((user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;

    if (emailEl) emailEl.value = user.email || '';

    if (unsubscribe) unsubscribe();
    unsubscribe = databaseService.subscribeToDocument('customers', user.uid, (snap) => {
        if (!snap.exists) return;
        const d = snap.data;
        if (nameEl)     nameEl.value     = d.name     || '';
        if (phoneEl)    phoneEl.value    = d.phone    || '';
        if (locationEl) locationEl.value = d.location || '';
        if (bioEl) {
            bioEl.value = d.bio || '';
            if (bioCount) bioCount.textContent = bioEl.value.length;
        }
    });
});

window.savePersonalInfo = async function () {
    if (!currentUser) return;

    const name     = (nameEl?.value     || '').trim();
    const phone    = (phoneEl?.value    || '').trim();
    const location = (locationEl?.value || '').trim();
    const bio      = (bioEl?.value      || '').trim();

    if (!name) { showToast('Full name is required.', 'error'); nameEl?.focus(); return; }

    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    saveBtn.textContent = 'Saving…';

    try {
        await databaseService.setDocument('customers', currentUser.uid,
            { name, phone, location, bio, updatedAt: new Date().toISOString() },
            { merge: true }
        );

        // Invalidate the 24h profile cache so any page that reads
        // HH_State.profile immediately after this save sees fresh data.
        // dashboardBadge.js handles this automatically on the dashboard via its
        // live subscription, but non-dashboard pages rely on the cached value.
        if (window.HH_State) window.HH_State.profile.clear();

        showToast('Profile updated successfully!', 'success');
    } catch (err) {
        console.error('Save personal info error:', err);
        showToast('Failed to save. Please try again.', 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.classList.remove('loading');
        saveBtn.textContent = 'Save Changes';
    }
};

window.addEventListener('pagehide', () => { if (unsubscribe) unsubscribe(); });

