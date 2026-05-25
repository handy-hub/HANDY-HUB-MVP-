import {
    waitForCurrentUser,
    subscribeToUserNotifications,
    markNotificationRead
} from "../../../shared/js/services/notificationRepository.js";

// ─── Icon map ───────────────────────────────────────────────────────────────
const TYPE_ICON = {
    Bookings: "fa-calendar-check",
    Messages: "fa-comment-dots",
    Offers:   "fa-tag",
    Payments: "fa-wallet",
    Reviews:  "fa-star",
    System:   "fa-bell",
    General:  "fa-shield-halved"
};

const TAB_TYPES = ["Bookings", "Messages", "Offers"];

// ─── Module state ────────────────────────────────────────────────────────────
let allNotifications = [];
let currentFilter    = "All";
let unsubscribeFn    = null;

// ─── Notification cache (stale-while-revalidate) ─────────────────────────────
const NOTIF_CACHE_KEY = 'hh_notifications_cache';

function saveNotifCache(notifications) {
    try {
        localStorage.setItem(NOTIF_CACHE_KEY, JSON.stringify(
            notifications.map(n => ({
                ...n,
                createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt
            }))
        ));
    } catch (_) {}
}

function loadNotifCache() {
    try {
        const raw = JSON.parse(localStorage.getItem(NOTIF_CACHE_KEY) || 'null');
        if (!raw) return null;
        return raw.map(n => ({ ...n, createdAt: n.createdAt ? new Date(n.createdAt) : new Date() }));
    } catch (_) { return null; }
}

// ─── DOM refs (resolved lazily so they are safe to call after DOMContentLoaded)
const dom = {
    tabContainer: () => document.getElementById("tabContainer"),
    notifList:    () => document.getElementById("notif-list"),
    pushBox:      () => document.getElementById("pushBox"),
    pushClose:    () => document.getElementById("push-close-btn")
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function esc(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatTime(date) {
    if (!(date instanceof Date) || isNaN(date)) return "";
    const diff = Math.floor((Date.now() - date) / 1000);
    if (diff < 60)    return "Just now";
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 172800) {
        return "Yesterday, " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getTabCounts(notifications) {
    const counts = { All: 0 };
    TAB_TYPES.forEach(t => { counts[t] = 0; });
    notifications.forEach(n => {
        if (!n.isRead) {
            counts.All++;
            if (counts[n.type] !== undefined) counts[n.type]++;
        }
    });
    return counts;
}

function syncBadge(notifications) {
    const count = notifications.filter(n => !n.isRead).length;
    try { localStorage.setItem("unread_notifications", count); } catch (_) {}
    // Refresh the floating nav badge in real-time (if floatingNav is loaded)
    if (typeof window.hhRefreshAlertBadge === 'function') window.hhRefreshAlertBadge();
    // Also update any legacy badge elements on this page
    const badge = document.querySelector(".notification-badge");
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? "99+" : count;
        badge.style.display = "flex";
    } else {
        badge.textContent = "";
        badge.style.display = "none";
    }
}

// ─── Render: tabs ────────────────────────────────────────────────────────────
function renderTabs(notifications) {
    const container = dom.tabContainer();
    if (!container) return;

    const counts = getTabCounts(notifications);
    const tabs   = ["All", ...TAB_TYPES];

    container.innerHTML = tabs.map(name => {
        const isActive = currentFilter === name;
        const count    = counts[name] ?? 0;
        return `
            <button type="button" data-filter="${name}"
                class="tab-btn${isActive ? " tab-btn--active" : ""}">
                <span class="tab-label">${name}</span>
                ${count > 0
                    ? `<span class="tab-badge${isActive ? " tab-badge--active" : ""}">${count}</span>`
                    : ""}
            </button>`;
    }).join("");

    container.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            currentFilter = btn.dataset.filter;
            renderTabs(allNotifications);
            renderList(allNotifications);
        });
    });
}

// ─── Render: single card ─────────────────────────────────────────────────────
function buildCard(n) {
    const icon     = TYPE_ICON[n.type] ?? "fa-bell";
    const isUnread = !n.isRead;
    return `
        <div data-id="${n.id}"
             class="notif-card${isUnread ? " notif-card--unread" : ""}">
            <div class="notif-icon-wrap${isUnread ? " notif-icon-wrap--unread" : ""}">
                <i class="fa-solid ${icon}"></i>
            </div>
            <div class="notif-body">
                <div class="notif-top-row">
                    <span class="notif-title">${esc(n.title)}</span>
                    <span class="notif-time">${formatTime(n.createdAt)}</span>
                </div>
                <p class="notif-msg">${esc(n.message)}</p>
            </div>
            ${isUnread ? '<div class="notif-dot"></div>' : ""}
        </div>`;
}

// ─── Render: list ────────────────────────────────────────────────────────────
function renderList(notifications) {
    const list = dom.notifList();
    if (!list) return;

    const filtered = currentFilter === "All"
        ? notifications
        : notifications.filter(n => n.type === currentFilter);

    if (filtered.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fa-regular fa-bell"></i></div>
                <p class="empty-title">No notifications yet</p>
                <p class="empty-sub">You're all caught up. We'll notify you when something new arrives.</p>
            </div>`;
        return;
    }

    const newItems     = filtered.filter(n => !n.isRead);
    const earlierItems = filtered.filter(n => n.isRead);
    let html = "";

    if (newItems.length > 0) {
        html += `<h3 class="group-header">New</h3>`;
        html += newItems.map(buildCard).join("");
    }
    if (earlierItems.length > 0) {
        html += `<h3 class="group-header">Earlier</h3>`;
        html += earlierItems.map(buildCard).join("");
    }

    list.innerHTML = html;

    list.querySelectorAll(".notif-card").forEach(card => {
        card.addEventListener("click", () => handleCardClick(card.dataset.id));
    });
}

// ─── Action: mark as read + optional navigation ───────────────────────────────
async function handleCardClick(id) {
    const notif = allNotifications.find(n => n.id === id);
    if (!notif) return;

    if (!notif.isRead) {
        // Optimistic update so the UI responds instantly
        notif.isRead = true;
        renderTabs(allNotifications);
        renderList(allNotifications);
        syncBadge(allNotifications);

        try {
            await markNotificationRead(id);
        } catch (err) {
            console.error("Failed to mark notification read:", err);
        }
    }

    if (notif.actionUrl) {
        window.location.href = notif.actionUrl;
    }
}

// ─── Loading / error states ───────────────────────────────────────────────────
function showLoading() {
    const list = dom.notifList();
    if (list) {
        list.innerHTML = `
            <div class="notif-loading">
                <div class="notif-spinner"></div>
            </div>`;
    }
}

function showError(msg) {
    const list = dom.notifList();
    if (list) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <p class="empty-title">${esc(msg)}</p>
            </div>`;
    }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
    // Paint from cache immediately — no spinner if we have stale data
    const cached = loadNotifCache();
    if (cached && cached.length > 0) {
        allNotifications = cached;
        syncBadge(cached);
        renderTabs(cached);
        renderList(cached);
    } else {
        renderTabs([]);
        showLoading();
    }

    const user = await waitForCurrentUser();

    if (!user) {
        showError("Sign in to see your notifications");
        return;
    }

    unsubscribeFn = subscribeToUserNotifications(
        user.uid,
        (notifications) => {
            allNotifications = notifications;
            syncBadge(notifications);
            renderTabs(notifications);
            renderList(notifications);
            saveNotifCache(notifications);
        },
        (err) => {
            console.error("Notification stream error:", err);
            // If Firestore needs an index it logs a URL — surface that hint
            if (!cached) showError("Could not load notifications. Check the console for details.");
        }
    );

    // Push-alert close button
    const closeBtn = dom.pushClose();
    const pushBox  = dom.pushBox();
    if (closeBtn && pushBox) {
        closeBtn.addEventListener("click", () => pushBox.remove());
    }
}

document.addEventListener("DOMContentLoaded", init);

// Clean up the Firestore listener when the user navigates away
window.addEventListener("pagehide", () => {
    if (unsubscribeFn) unsubscribeFn();
});

