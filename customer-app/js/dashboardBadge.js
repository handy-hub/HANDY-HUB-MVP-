import { getAppContainer }         from '../../shared/js/app/container.js';
import { subscribeToUnreadCount } from '../../shared/js/services/notificationRepository.js';

// Active cleanup handles — cancelled when auth state changes
let unsubscribeCount   = null;
let unsubscribeProfile = null;

// ── DOM painters ──────────────────────────────────────────────────────────────

function updateBadgeEl(count) {
    try { localStorage.setItem('unread_notifications', count); } catch (_) {}

    const badge = document.getElementById('notif-badge');
    if (!badge) return;

    if (count > 0) {
        badge.textContent   = count > 99 ? '99+' : String(count);
        badge.style.display = 'flex';
    } else {
        badge.textContent   = '';
        badge.style.display = 'none';
    }
}

function removeSkel(el) {
    if (!el) return;
    el.classList.remove('skel', 'skel-circle');
    el.style.minWidth = '';
}

function applyProfileToDOM(data) {
    if (!data || !data.name) return;

    const nameEl     = document.getElementById('uc-name');
    const imgEl      = document.getElementById('uc-avatar');
    const sideNameEl = document.getElementById('sidebar-name');
    const sideImgEl  = document.getElementById('sidebar-profile-img');
    const locEl      = document.getElementById('uc-loc-text');

    const src = data.profileImage ||
        (data.name
            ? 'https://ui-avatars.com/api/?background=730201&color=fff&size=128&name=' +
              encodeURIComponent((data.name || 'U').slice(0, 2).toUpperCase())
            : null);

    if (nameEl     && data.name)     { nameEl.textContent     = data.name;     removeSkel(nameEl); }
    if (sideNameEl && data.name)       sideNameEl.textContent = data.name;
    if (locEl      && data.location) { locEl.textContent      = data.location; removeSkel(locEl); }
    if (imgEl      && src)           { imgEl.src = src;                        removeSkel(imgEl); }
    if (sideImgEl  && src)             sideImgEl.src = src;
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

function teardown() {
    if (unsubscribeCount)   { unsubscribeCount();   unsubscribeCount   = null; }
    if (unsubscribeProfile) { unsubscribeProfile(); unsubscribeProfile = null; }
}

// ── Auth state driver ─────────────────────────────────────────────────────────

const { services: { authService } } = getAppContainer();

authService.subscribeToAuthState(user => {
    teardown(); // always cancel previous subscriptions first

    if (!user) {
        updateBadgeEl(0);
        if (window.HH_State) window.HH_State.clearUser();
        return;
    }

    // Activate uid-scoped storage (authGuard also does this, but dashboardBadge
    // runs before some pages call requireAuth explicitly)
    if (window.HH_State) window.HH_State.setUser(user.uid);

    // ── Notification badge (live count) ──────────────────────────────────────
    unsubscribeCount = subscribeToUnreadCount(user.uid, count => {
        updateBadgeEl(count);
    });

    // ── Live profile subscription ─────────────────────────────────────────────
    // subscribeToDocument → updates automatically on every Firestore write
    // (name change, avatar upload, balance credit, etc.) without page refresh.
    const { services: { databaseService } } = getAppContainer();

    unsubscribeProfile = databaseService.subscribeToDocument(
        'customers',
        user.uid,
        snap => {
            if (!snap || !snap.exists) return;

            // Write to UID-scoped, timestamped cache via service layer
            if (window.HH_State) {
                window.HH_State.profile.set(snap.data, user.uid);
            }

            // Repaint dashboard header in real time
            applyProfileToDOM(snap.data);
        },
        () => { /* ignore snapshot errors on the badge layer */ }
    );
});
