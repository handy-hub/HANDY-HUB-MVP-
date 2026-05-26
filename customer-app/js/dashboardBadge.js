import { getAppContainer } from "../../shared/js/app/container.js";
import { subscribeToUnreadCount } from "../../shared/js/services/notificationRepository.js";

const PROFILE_CACHE_KEY = 'hh_profile_cache';

let unsubscribeCount = null;

function updateBadgeEl(count) {
    try { localStorage.setItem("unread_notifications", count); } catch (_) {}

    const badge = document.getElementById("notif-badge");
    if (!badge) return;

    if (count > 0) {
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.style.display = "flex";
    } else {
        badge.textContent = "";
        badge.style.display = "none";
    }
}

function removeSkel(el) { if (el) { el.classList.remove('skel', 'skel-circle'); el.style.minWidth = ''; } }

function applyProfileCache(data) {
    if (!data) return;
    const nameEl     = document.getElementById('uc-name');
    const imgEl      = document.getElementById('uc-avatar');
    const sideNameEl = document.getElementById('sidebar-name');
    const sideImgEl  = document.getElementById('sidebar-profile-img');
    const locEl      = document.getElementById('uc-loc-text');
    const src = data.profileImage ||
        (data.name ? 'https://ui-avatars.com/api/?background=730201&color=fff&size=128&name=' +
            encodeURIComponent((data.name || 'U').slice(0, 2).toUpperCase()) : null);

    if (nameEl     && data.name)     { nameEl.textContent     = data.name.split(' ')[0] + ' ' + data.name.split(' ')[1]; removeSkel(nameEl); }
    if (sideNameEl && data.name)       sideNameEl.textContent = data.name;
    if (locEl      && data.location) { locEl.textContent      = data.location; removeSkel(locEl); }
    if (imgEl      && src)           { imgEl.src = src; removeSkel(imgEl); }
    if (sideImgEl  && src)             sideImgEl.src = src;
}

const { services: { authService } } = getAppContainer();

authService.subscribeToAuthState((user) => {
    if (unsubscribeCount) {
        unsubscribeCount();
        unsubscribeCount = null;
    }

    if (!user) {
        updateBadgeEl(0);
        return;
    }

    unsubscribeCount = subscribeToUnreadCount(user.uid, (count) => {
        updateBadgeEl(count);
    });

    // Background-refresh profile cache so dashboard header stays current
    const { services: { databaseService } } = getAppContainer();
    databaseService.getDocument('customers', user.uid)
        .then(snap => {
            if (snap && snap.exists) {
                try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(snap.data)); } catch (_) {}
                applyProfileCache(snap.data);
            }
        })
        .catch(() => {});
});
