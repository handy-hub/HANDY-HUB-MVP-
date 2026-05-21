import '../../../shared/js/utils/global-app.js';
import { getAppContainer }     from '../../../shared/js/app/container.js';
import { initPaymentModal }    from './paymentMethodsModal.js';

const LOGIN_URL = 'login.html';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const avatarImg         = document.getElementById('profile-avatar');
const greetingEl        = document.getElementById('profile-greeting');
const nameEl            = document.getElementById('profile-name');
const emailEl           = document.getElementById('profile-email');
const phoneTextEl       = document.getElementById('profile-phone-text');
const locationEl        = document.getElementById('profile-location');
const bioEl             = document.getElementById('profile-bio');
const bioRow            = document.getElementById('bio-row');
const cameraBtn         = document.getElementById('camera-btn');
const photoInput        = document.getElementById('profile-photo-input');
const logoutBtn         = document.querySelector('.logout-btn');
const walletDisplay     = document.getElementById('wallet-balance-display');
const statBookings      = document.getElementById('stat-bookings');
const statSpent         = document.getElementById('stat-spent');
const statWallet        = document.getElementById('stat-wallet');
const completeBanner    = document.getElementById('complete-banner');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_AVATAR   = 'https://ui-avatars.com/api/?background=730201&color=fff&size=128&name=User';

// ── Toast ─────────────────────────────────────────────────────────────────────
const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 7L10.25 16.75L6 12.5" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8V13" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/><path d="M12 16.5V16.55" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/><path d="M10.29 3.86L1.82 18A2 2 0 0 0 3.53 21H20.47A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 10V16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12 7.6V7.65" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
};

function showToast(message, type = 'info') {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span class="toast-message">${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 320);
    }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildGreeting(name) {
    const h = new Date().getHours();
    const s = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const first = (name || '').split(' ')[0] || 'there';
    return `${s}, ${first} 👋`;
}

function buildDefaultAvatar(name) {
    const enc = encodeURIComponent((name || 'User').slice(0, 2).toUpperCase());
    return `https://ui-avatars.com/api/?background=730201&color=fff&size=128&name=${enc}`;
}

function formatGHC(n) {
    return 'GHC ' + Number(n || 0).toFixed(2);
}

function formatGHCShort(n) {
    const v = Number(n || 0);
    return v >= 1000 ? 'GHC ' + (v / 1000).toFixed(1) + 'k' : 'GHC ' + v.toFixed(0);
}

// ── Populate profile ──────────────────────────────────────────────────────────
function populateProfile(data) {
    if (!data) return;

    const name     = data.name     || 'No name set';
    const email    = data.email    || 'No email set';
    const phone    = data.phone    || 'No phone set';
    const location = data.location || 'No location set';
    const bio      = data.bio      || '';
    const photo    = data.profileImage || '';
    const wallet   = Number(data.walletBalance || 0);
    const bookings = Number(data.bookings      || 0);
    const spent    = Number(data.spent         || 0);

    if (greetingEl)   greetingEl.textContent = buildGreeting(name);
    if (nameEl)       nameEl.textContent     = name;
    if (emailEl)      emailEl.textContent    = email;
    if (phoneTextEl)  phoneTextEl.textContent = phone;
    if (locationEl)   locationEl.textContent = location;

    if (bioEl && bioRow) {
        bioEl.textContent   = bio;
        bioRow.style.display = bio ? '' : 'none';
    }

    if (avatarImg) {
        const target = photo || buildDefaultAvatar(name);
        if (avatarImg.src !== target) avatarImg.src = target;
    }

    // Wallet balance displays
    if (walletDisplay) walletDisplay.textContent = formatGHC(wallet);
    if (statWallet)    statWallet.textContent    = formatGHCShort(wallet);
    if (statBookings)  statBookings.textContent  = String(bookings);
    if (statSpent)     statSpent.textContent     = formatGHCShort(spent);

    // Hide "complete profile" banner if core fields are set
    if (completeBanner) {
        const isComplete = data.name && data.phone && data.location;
        completeBanner.style.display = isComplete ? 'none' : '';
    }
}

// ── Avatar error fallback ─────────────────────────────────────────────────────
if (avatarImg) {
    avatarImg.addEventListener('error', () => { avatarImg.src = DEFAULT_AVATAR; });
}

// ── Photo upload ──────────────────────────────────────────────────────────────
let currentUserId = null;

function setCameraLoading(isLoading) {
    if (!cameraBtn) return;
    cameraBtn.disabled    = isLoading;
    cameraBtn.style.opacity = isLoading ? '0.5' : '1';
    cameraBtn.style.cursor  = isLoading ? 'not-allowed' : 'pointer';
}

async function handlePhotoUpload(file) {
    if (!currentUserId) { showToast('You must be logged in.', 'error'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { showToast('Image must be smaller than 5 MB.', 'error'); return; }
    if (!file.type.startsWith('image/')) { showToast('Please select a valid image.', 'error'); return; }

    const prevSrc    = avatarImg ? avatarImg.src : DEFAULT_AVATAR;
    const previewUrl = URL.createObjectURL(file);
    if (avatarImg) avatarImg.src = previewUrl;
    setCameraLoading(true);

    try {
        const { services: { storageService, databaseService } } = getAppContainer();
        const path = `customers/${currentUserId}/profileImage`;
        await storageService.uploadFile(path, file, { contentType: file.type });
        const url = await storageService.getDownloadUrl(path);
        await databaseService.setDocument('customers', currentUserId, { profileImage: url }, { merge: true });
        showToast('Photo updated!', 'success');
    } catch (err) {
        console.error('Upload error:', err);
        showToast('Failed to upload photo.', 'error');
        if (avatarImg) avatarImg.src = prevSrc;
    } finally {
        setCameraLoading(false);
        if (photoInput) photoInput.value = '';
        URL.revokeObjectURL(previewUrl);
    }
}

if (cameraBtn && photoInput) {
    cameraBtn.addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) handlePhotoUpload(f); });
}

// ── Logout ────────────────────────────────────────────────────────────────────
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        if (!window.confirm('Are you sure you want to log out?')) return;
        logoutBtn.textContent = 'Logging out…';
        logoutBtn.disabled    = true;
        try {
            const { services: { sessionService } } = getAppContainer();
            await sessionService.logout();
        } catch (err) {
            console.error('Logout error:', err);
        } finally {
            window.location.href = LOGIN_URL;
        }
    });
}

// ── Bottom nav ────────────────────────────────────────────────────────────────
function initBottomNav() {
    document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.bottom-nav .nav-item').forEach(n => {
                n.classList.remove('active');
                const lbl = n.querySelector('span');
                if (lbl) lbl.classList.remove('active-label');
                n.querySelectorAll('path,circle,polyline,line,rect,polygon')
                 .forEach(p => p.setAttribute('stroke', '#aaa'));
            });
            item.classList.add('active');
            const span = item.querySelector('span');
            if (span) span.classList.add('active-label');
            item.querySelectorAll('path,circle,polyline,line,rect,polygon')
                .forEach(p => p.setAttribute('stroke', '#730201'));
        });
    });
}

// ── Auth bootstrap ────────────────────────────────────────────────────────────
let unsubSnapshot = null;

const { services: { authService } } = getAppContainer();

authService.subscribeToAuthState(user => {
    if (!user) { window.location.href = LOGIN_URL; return; }
    currentUserId = user.uid;

    const { services: { databaseService } } = getAppContainer();

    // Live profile data
    if (unsubSnapshot) unsubSnapshot();
    unsubSnapshot = databaseService.subscribeToDocument(
        'customers', user.uid,
        snap => {
            if (snap.exists) {
                populateProfile(snap.data);
            } else {
                populateProfile({ name: user.displayName || '', email: user.email || '', phone: user.phoneNumber || '' });
            }
        },
        err => {
            console.error('Profile snapshot error:', err);
            showToast('Could not load profile.', 'error');
        }
    );

    // Init payment methods modal (wires up [data-open-payments] triggers)
    initPaymentModal(user.uid, databaseService);

    initBottomNav();
});
