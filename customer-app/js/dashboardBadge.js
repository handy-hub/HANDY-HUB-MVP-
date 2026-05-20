/**
 * dashboardBadge.js
 * Live notification-badge updater for the dashboard.
 * Loaded as type="module" so it can use ES-module Firebase imports.
 * Works independently of helpers.js; the localStorage value it writes
 * acts as a fast-render cache for the next page load.
 */
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { firebaseAuth } from "../../shared/js/backend/providers/firebase/firebaseConfig.js";
import { subscribeToUnreadCount } from "../../shared/js/services/notificationRepository.js";

let unsubscribeCount = null;

function updateBadgeEl(count) {
    try { localStorage.setItem("unread_notifications", count); } catch (_) {}

    const badge = document.querySelector(".notification-badge");
    if (!badge) return;

    if (count > 0) {
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.style.display = "flex";
    } else {
        badge.textContent = "";
        badge.style.display = "none";
    }
}

onAuthStateChanged(firebaseAuth, (user) => {
    // Tear down any previous listener (e.g. after sign-out / sign-in cycle)
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
});
