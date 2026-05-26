import {
    waitForCurrentUser,
    subscribeToUserNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
} from "../../../shared/js/services/notificationRepository.js";
import { getAppContainer } from "../../../shared/js/app/container.js";

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

// Maps Firestore notification type → customer.notificationPreferences key
const TYPE_TO_PREF = {
    Bookings: 'bookings',
    Messages: 'messages',
    Offers:   'offers',
    Payments: 'payments',
    Reviews:  'reviews',
    System:   'system',
    // 'General' has no toggle → always shown
};

// ─── Module state ────────────────────────────────────────────────────────────
let allNotifications  = [];   // raw list from Firestore (never filtered)
let currentFilter     = "All";
let unsubscribeFn     = null;
let prefsUnsubFn      = null;
let currentUserId     = null;
let _initialized      = false;

// Live notification preferences (mirrors customer.notificationPreferences in Firestore)
// Default: all on — any disabled key must be explicitly false
let notificationPrefs = {
    bookings: true, messages: true, offers: true,
    payments: true, reviews:  true, system: true,
};

// Used to suppress a card-click that fires immediately after a swipe gesture
let _lastSwipeTime = 0;

// ─── Preference filter ───────────────────────────────────────────────────────
/**
 * Returns only the notifications whose type hasn't been turned off in Settings.
 * 'General' and any unknown types are always included.
 */
function applyPrefsFilter(notifications) {
    return notifications.filter(n => {
        const key = TYPE_TO_PREF[n.type];
        if (!key) return true;                  // General / unknown → always show
        return notificationPrefs[key] !== false; // default true if key absent
    });
}

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

// ─── DOM refs ────────────────────────────────────────────────────────────────
const dom = {
    tabContainer: () => document.getElementById("tabContainer"),
    notifList:    () => document.getElementById("notif-list"),
    pushBox:      () => document.getElementById("pushBox"),
    pushClose:    () => document.getElementById("push-close-btn"),
    markAllBtn:   () => document.getElementById("markAllReadBtn"),
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
    if (diff < 60)     return "Just now";
    if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 172800) return "Yesterday, " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Count unread per tab — operates on ALREADY-FILTERED notifications
function getTabCounts(visibleNotifications) {
    const counts = { All: 0 };
    TAB_TYPES.forEach(t => { counts[t] = 0; });
    visibleNotifications.forEach(n => {
        if (!n.isRead) {
            counts.All++;
            if (counts[n.type] !== undefined) counts[n.type]++;
        }
    });
    return counts;
}

// Badge count and localStorage — uses pref-filtered set so the badge matches
// exactly what the user can see in the notification list
function syncBadge(notifications) {
    const visible = applyPrefsFilter(notifications);
    const count   = visible.filter(n => !n.isRead).length;
    try { localStorage.setItem("unread_notifications", String(count)); } catch (_) {}
    if (typeof window.hhRefreshAlertBadge === 'function') window.hhRefreshAlertBadge();
}

function updateMarkAllReadBtn() {
    const btn = dom.markAllBtn();
    if (!btn) return;
    // Only show if there are unread notifications the user can currently see
    const hasVisibleUnread = applyPrefsFilter(allNotifications).some(n => !n.isRead);
    btn.style.display = hasVisibleUnread ? 'flex' : 'none';
}

// ─── Render: tabs ────────────────────────────────────────────────────────────
function renderTabs(notifications) {
    const container = dom.tabContainer();
    if (!container) return;

    // Tab badge counts are based on what's visible after pref filtering
    const visible = applyPrefsFilter(notifications);
    const counts  = getTabCounts(visible);
    const tabs    = ["All", ...TAB_TYPES];

    container.innerHTML = tabs.map(name => {
        const isActive  = currentFilter === name;
        const count     = counts[name] ?? 0;
        // Grey out tab label if the type is disabled in settings
        const prefKey   = TYPE_TO_PREF[name];
        const isDisabled = prefKey && notificationPrefs[prefKey] === false;
        return `
            <button type="button" data-filter="${name}"
                class="tab-btn${isActive ? " tab-btn--active" : ""}${isDisabled ? " tab-btn--muted" : ""}">
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
        <div class="notif-swipe-row">
            <div class="notif-delete-action" aria-hidden="true">
                <i class="fa-solid fa-trash"></i>
                <span>Delete</span>
            </div>
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
            </div>
        </div>`;
}

// ─── Render: list ─────────────────────────────────────────────────────────────
function renderList(notifications) {
    const list = dom.notifList();
    if (!list) return;

    // Step 1: apply notification settings (disabled types hidden)
    const prefFiltered = applyPrefsFilter(notifications);

    // Step 2: apply the active tab filter on top
    const filtered = currentFilter === "All"
        ? prefFiltered
        : prefFiltered.filter(n => n.type === currentFilter);

    if (filtered.length === 0) {
        list.innerHTML = buildEmptyState(notifications, prefFiltered);
        return;
    }

    const newItems     = filtered.filter(n => !n.isRead);
    const earlierItems = filtered.filter(n =>  n.isRead);
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
        card.addEventListener("click", () => {
            if (Date.now() - _lastSwipeTime < 300) return;
            handleCardClick(card.dataset.id);
        });
    });

    wireSwipeToDelete(list);
    updateMarkAllReadBtn();
}

// ─── Empty-state helper ───────────────────────────────────────────────────────
function buildEmptyState(allNotifs, visibleNotifs) {
    let title, sub, icon = "fa-regular fa-bell";

    if (allNotifs.length === 0) {
        // Nothing in Firestore at all
        title = "No notifications yet";
        sub   = "You're all caught up. We'll notify you when something new arrives.";

    } else if (currentFilter !== "All") {
        // A specific tab is selected
        const prefKey = TYPE_TO_PREF[currentFilter];
        if (prefKey && notificationPrefs[prefKey] === false) {
            // This type is turned off in settings
            icon  = "fa-solid fa-bell-slash";
            title = `${currentFilter} notifications are off`;
            sub   = `Go to Notification Settings to turn them back on.`;
        } else {
            title = `No ${currentFilter.toLowerCase()} notifications`;
            sub   = "Nothing here yet.";
        }

    } else {
        // "All" tab but everything is hidden by prefs
        if (visibleNotifs.length === 0 && allNotifs.length > 0) {
            icon  = "fa-solid fa-bell-slash";
            title = "All notification types are muted";
            sub   = "Enable notification types in Settings to see them here.";
        } else {
            title = "No notifications yet";
            sub   = "You're all caught up. We'll notify you when something new arrives.";
        }
    }

    return `
        <div class="empty-state">
            <div class="empty-icon"><i class="${icon}"></i></div>
            <p class="empty-title">${title}</p>
            <p class="empty-sub">${sub}</p>
        </div>`;
}

// ─── Swipe-to-delete ─────────────────────────────────────────────────────────
function wireSwipeToDelete(listEl) {
    const DELETE_THRESHOLD = 72;
    const MAX_DRAG         = 90;

    listEl.querySelectorAll('.notif-swipe-row').forEach(row => {
        const card     = row.querySelector('.notif-card');
        const deleteEl = row.querySelector('.notif-delete-action');
        if (!card) return;

        const id = card.dataset.id;
        let startX = 0, startY = 0, currentDx = 0;
        let tracking = false, didRealSwipe = false, direction = null;

        function cancelGesture() { tracking = false; direction = null; }

        function onTouchStart(e) {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentDx = 0; tracking = true; didRealSwipe = false; direction = null;
            card.style.transition = 'none';
        }

        function onTouchMove(e) {
            if (!tracking || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;

            if (direction === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                direction = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
            }
            if (direction === 'v') { cancelGesture(); return; }

            if (direction === 'h' && dx < 0) {
                e.preventDefault();
                didRealSwipe = true;
                currentDx = Math.max(dx, -(MAX_DRAG + 22));
                card.style.transform = `translateX(${currentDx}px)`;
                if (deleteEl) {
                    const ratio = Math.min(Math.abs(currentDx) / DELETE_THRESHOLD, 1.3);
                    deleteEl.style.transform  = `scale(${(0.85 + ratio * 0.25).toFixed(3)})`;
                    deleteEl.style.background = currentDx < -DELETE_THRESHOLD ? '#b71c1c' : '#d32f2f';
                }
            }
        }

        function onTouchEnd() {
            if (!tracking) return;
            tracking = false;
            if (didRealSwipe) _lastSwipeTime = Date.now();

            if (currentDx < -DELETE_THRESHOLD) {
                if (navigator.vibrate) navigator.vibrate(12);
                card.style.transition = 'transform 0.22s ease-in';
                card.style.transform  = 'translateX(-110%)';
                setTimeout(() => {
                    const h = row.offsetHeight;
                    row.style.height = h + 'px';
                    void row.offsetHeight;
                    row.style.transition = 'height 0.26s ease, opacity 0.18s ease';
                    row.style.overflow   = 'hidden';
                    row.style.opacity    = '0';
                    row.style.height     = '0';
                    setTimeout(() => {
                        if (row.parentNode) row.remove();
                        handleDeleteNotification(id);
                    }, 270);
                }, 210);
            } else {
                card.style.transition = 'transform 0.42s cubic-bezier(0.34,1.56,0.64,1)';
                card.style.transform  = 'translateX(0)';
                if (deleteEl) {
                    deleteEl.style.transition = 'transform 0.42s cubic-bezier(0.34,1.56,0.64,1), background 0.2s';
                    deleteEl.style.transform  = '';
                    deleteEl.style.background = '';
                }
                setTimeout(() => {
                    card.style.transition = '';
                    card.style.transform  = '';
                    if (deleteEl) deleteEl.style.transition = '';
                }, 450);
            }
        }

        card.addEventListener('touchstart',  onTouchStart,  { passive: true  });
        card.addEventListener('touchmove',   onTouchMove,   { passive: false });
        card.addEventListener('touchend',    onTouchEnd);
        card.addEventListener('touchcancel', onTouchEnd);
    });
}

// ─── Actions ─────────────────────────────────────────────────────────────────
async function handleDeleteNotification(id) {
    allNotifications = allNotifications.filter(n => n.id !== id);
    syncBadge(allNotifications);
    renderTabs(allNotifications);
    saveNotifCache(allNotifications);
    updateMarkAllReadBtn();
    try {
        await deleteNotification(id);
    } catch (err) {
        console.error('[notifPage] Failed to delete from Firestore:', err);
    }
}

async function handleCardClick(id) {
    const notif = allNotifications.find(n => n.id === id);
    if (!notif) return;

    if (!notif.isRead) {
        notif.isRead = true;
        renderTabs(allNotifications);
        renderList(allNotifications);
        syncBadge(allNotifications);
        saveNotifCache(allNotifications);
        try {
            await markNotificationRead(id);
        } catch (err) {
            console.error("[notifPage] Failed to mark read:", err);
        }
    }

    if (notif.actionUrl) window.location.href = notif.actionUrl;
}

// ─── Loading / error states ───────────────────────────────────────────────────
function showLoading() {
    const list = dom.notifList();
    if (list) list.innerHTML = `<div class="notif-loading"><div class="notif-spinner"></div></div>`;
}

function showError(msg) {
    const list = dom.notifList();
    if (list) list.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
            <p class="empty-title">${esc(msg)}</p>
        </div>`;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
    if (_initialized) return;
    _initialized = true;

    if (unsubscribeFn) { unsubscribeFn(); unsubscribeFn = null; }

    // Paint from cache immediately (stale-while-revalidate)
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
    if (!user) { showError("Sign in to see your notifications"); return; }
    currentUserId = user.uid;

    const { services: { databaseService } } = getAppContainer();

    // ── 1. Live notification preferences ─────────────────────────────────────
    // Subscribe to the customer document so any toggle change in settings is
    // reflected instantly here without a page reload.
    prefsUnsubFn = databaseService.subscribeToDocument('customers', user.uid, (snap) => {
        const raw = snap.exists ? (snap.data?.notificationPreferences ?? {}) : {};
        notificationPrefs = {
            bookings: raw.bookings !== false,
            messages: raw.messages !== false,
            offers:   raw.offers   !== false,
            payments: raw.payments !== false,
            reviews:  raw.reviews  !== false,
            system:   raw.system   !== false,
        };
        // Re-render the list and badge with the updated pref filter applied
        renderTabs(allNotifications);
        renderList(allNotifications);
        syncBadge(allNotifications);
    });

    // ── 2. Mark-All-Read button ───────────────────────────────────────────────
    const markAllBtn = dom.markAllBtn();
    if (markAllBtn) {
        markAllBtn.addEventListener('click', async () => {
            if (!currentUserId) return;
            markAllBtn.disabled = true;
            allNotifications.forEach(n => { n.isRead = true; });
            renderTabs(allNotifications);
            renderList(allNotifications);
            syncBadge(allNotifications);
            saveNotifCache(allNotifications);
            try {
                await markAllNotificationsRead(currentUserId);
            } catch (err) {
                console.error("[notifPage] markAllNotificationsRead failed:", err);
            } finally {
                markAllBtn.disabled = false;
            }
        });
    }

    // ── 3. Realtime notifications stream ─────────────────────────────────────
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
            console.error("[notifPage] Notification stream error:", err);
            if (!cached) showError("Could not load notifications.");
        }
    );

    // ── 4. Push-alert dismiss ─────────────────────────────────────────────────
    const closeBtn = dom.pushClose();
    const pushBox  = dom.pushBox();
    if (closeBtn && pushBox) closeBtn.addEventListener("click", () => pushBox.remove());
}

document.addEventListener("DOMContentLoaded", init);

window.addEventListener("pagehide", () => {
    if (unsubscribeFn)  { unsubscribeFn();  unsubscribeFn  = null; }
    if (prefsUnsubFn)   { prefsUnsubFn();   prefsUnsubFn   = null; }
});
