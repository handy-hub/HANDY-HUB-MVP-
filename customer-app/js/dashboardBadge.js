import { getAppContainer } from "../../shared/js/app/container.js";
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
});
