import {
    waitForCurrentUser,
    subscribeToUserNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
} from "../../../shared/js/services/notificationRepository.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { wireSwipeAction, createUndoToast } from "../../../shared/js/components/swipeAction.js";

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

const TYPE_TO_PREF = {
    Bookings: 'bookings',
    Messages: 'messages',
    Offers:   'offers',
    Payments: 'payments',
    Reviews:  'reviews',
    System:   'system',
};

// ─── Module state ────────────────────────────────────────────────────────────
let allNotifications  = [];
let currentFilter     = "All";
let unsubscribeFn     = null;
let prefsUnsubFn      = null;
let currentUserId     = null;
let _initialized      = false;

let notificationPrefs = {
    bookings: true, messages: true, offers: true,
    payments: true, reviews:  true, system: true,
};

// IDs currently in the undo-pending window.
// Firestore subscription updates filter these out so the optimistic removal
// is not clobbered by a Firestore snapshot that still contains the item.
const _pendingDeletionIds = new Set();

const undoToast = createUndoToast({ message: 'Notification deleted', icon: 'fa-solid fa-trash-can' });
let getLastSwipeTime = () => 0;

// ─── Preference filter ───────────────────────────────────────────────────────
function applyPrefsFilter(notifications) {
    return notifications.filter(n => {
        const key = TYPE_TO_PREF[n.type];
        if (!key) return true;
        return notificationPrefs[key] !== false;
    });
}

// ─── Notification cache ──────────────────────────────────────────────────────
const NOTIF_CACHE_BASE = 'hh_notifications_cache';
// Scoped to uid in init() — defaults to bare base key as safety fallback
let NOTIF_CACHE_KEY = NOTIF_CACHE_BASE;

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

function syncBadge(notifications) {
    const visible = applyPrefsFilter(notifications);
    const count   = visible.filter(n => !n.isRead).length;
    try { localStorage.setItem("unread_notifications", String(count)); } catch (_) {}
    if (typeof window.hhRefreshAlertBadge === 'function') window.hhRefreshAlertBadge();
}

function updateMarkAllReadBtn() {
    const btn = dom.markAllBtn();
    if (!btn) return;
    const hasVisibleUnread = applyPrefsFilter(allNotifications).some(n => !n.isRead);
    btn.style.display = hasVisibleUnread ? 'flex' : 'none';
}

// ─── Render: tabs ─────────────────────────────────────────────────────────────
function renderTabs(notifications) {
    const container = dom.tabContainer();
    if (!container) return;

    const visible = applyPrefsFilter(notifications);
    const counts  = getTabCounts(visible);
    const tabs    = ["All", ...TAB_TYPES];

    container.innerHTML = tabs.map(name => {
        const isActive   = currentFilter === name;
        const count      = counts[name] ?? 0;
        const prefKey    = TYPE_TO_PREF[name];
        const isDisabled = prefKey && notificationPrefs[prefKey] === false;
        return `
            <button type="button" role="tab" data-filter="${name}"
                aria-selected="${isActive}"
                class="ui-tab${isActive ? " ui-tab--active" : ""}${isDisabled ? " ui-tab--muted" : ""}">
                <span class="tab-label">${name}</span>
                ${count > 0
                    ? `<span class="ui-tab-badge">${count}</span>`
                    : ""}
            </button>`;
    }).join("");

    container.querySelectorAll(".ui-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            currentFilter = btn.dataset.filter;
            renderTabs(allNotifications);
            renderList(allNotifications);
        });
    });
}

// ─── Render: single card ──────────────────────────────────────────────────────
function buildCard(n) {
    const icon     = TYPE_ICON[n.type] ?? "fa-bell";
    const isUnread = !n.isRead;
    return `
        <div class="swipe-row">
            <div class="swipe-action" aria-hidden="true">
                <i class="fa-solid fa-trash"></i>
                <span>Delete</span>
            </div>
            <div data-id="${esc(n.id)}"
                 class="swipe-card notif-card${isUnread ? " notif-card--unread" : ""}">
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

    const prefFiltered = applyPrefsFilter(notifications);
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
            if (Date.now() - getLastSwipeTime() < 300) return;
            handleCardClick(card.dataset.id);
        });
    });

    getLastSwipeTime = wireSwipeAction(list, { onCommit: initiateDelete });
    updateMarkAllReadBtn();
}

// ─── Empty-state helper ───────────────────────────────────────────────────────
function buildEmptyState(allNotifs, visibleNotifs) {
    let title, sub, icon = "fa-regular fa-bell";

    if (allNotifs.length === 0) {
        title = "No notifications yet";
        sub   = "You're all caught up. We'll notify you when something new arrives.";
    } else if (currentFilter !== "All") {
        const prefKey = TYPE_TO_PREF[currentFilter];
        if (prefKey && notificationPrefs[prefKey] === false) {
            icon  = "fa-solid fa-bell-slash";
            title = `${currentFilter} notifications are off`;
            sub   = `Go to Notification Settings to turn them back on.`;
        } else {
            title = `No ${currentFilter.toLowerCase()} notifications`;
            sub   = "Nothing here yet.";
        }
    } else {
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

// ─── Delete with undo ─────────────────────────────────────────────────────────
/**
 * Optimistically removes a notification from the UI and shows the undo toast.
 * The actual Firestore deletion is deferred until:
 *   a) The toast timer expires (user did not tap Undo), OR
 *   b) A second deletion arrives (previous one is committed first), OR
 *   c) The page is about to unload (pagehide → commitAll).
 *
 * The cache is intentionally NOT updated here. It is updated only on commit.
 * This means a page refresh during the undo window will restore the item from
 * the Firestore subscription (correct behaviour — refresh acts as implicit undo).
 */
function initiateDelete(id) {
    const index        = allNotifications.findIndex(n => n.id === id);
    const notification = index >= 0 ? allNotifications[index] : null;

    // Guard: already pending or not found
    if (!notification || _pendingDeletionIds.has(id)) return;

    // Optimistic removal from live state (not from cache yet)
    allNotifications = allNotifications.filter(n => n.id !== id);
    _pendingDeletionIds.add(id);

    // Update badges + tabs without the deleted item
    syncBadge(allNotifications);
    renderTabs(allNotifications);
    updateMarkAllReadBtn();
    // NOTE: renderList is NOT called here — the DOM row was already removed
    // by the swipe animation. This avoids a jarring re-render.

    undoToast.show(
        id,
        { notification, originalIndex: index },
        (committedId) => {
            _pendingDeletionIds.delete(committedId);
            saveNotifCache(allNotifications);
            syncBadge(allNotifications);
            updateMarkAllReadBtn();
            deleteNotification(committedId).catch(err => {
                console.warn('[notifPage] Undo-toast commit failed:', err);
            });
        },
        (restoreData) => {
            if (!restoreData) return;
            _pendingDeletionIds.delete(id);

            // Re-insert at original position (clamped to current array length)
            const insertAt = Math.min(restoreData.originalIndex, allNotifications.length);
            allNotifications.splice(insertAt, 0, restoreData.notification);

            // Full re-render with restored item + update cache
            syncBadge(allNotifications);
            renderTabs(allNotifications);
            renderList(allNotifications);
            saveNotifCache(allNotifications);
        }
    );
}

// ─── Actions ──────────────────────────────────────────────────────────────────
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
function skeletonCard() {
    return `
        <div class="notif-skel-card">
            <div class="notif-skel-icon"></div>
            <div class="notif-skel-body">
                <div class="notif-skel-line title"></div>
                <div class="notif-skel-line msg"></div>
                <div class="notif-skel-line msg-short"></div>
            </div>
        </div>`;
}

function showLoading() {
    const list = dom.notifList();
    if (list) list.innerHTML = Array(5).fill(skeletonCard()).join('');
}

function showError(msg) {
    const list = dom.notifList();
    if (list) list.innerHTML = `
        <div class="empty-state">
            <div class="empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
            <p class="empty-title">${esc(msg)}</p>
        </div>`;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
    if (_initialized) return;
    _initialized = true;

    if (unsubscribeFn) { unsubscribeFn(); unsubscribeFn = null; }

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
    currentUserId    = user.uid;
    NOTIF_CACHE_KEY  = NOTIF_CACHE_BASE + '_' + user.uid; // uid-scope the cache key

    const { services: { databaseService } } = getAppContainer();

    // ── 1. Live notification preferences ─────────────────────────────────────
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
        renderTabs(allNotifications);
        renderList(allNotifications);
        syncBadge(allNotifications);
    }, (err) => {
        console.warn('[notificationPage] prefs listener error:', err);
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

    // ── 3. Realtime notifications stream ──────────────────────────────────────
    // IMPORTANT: filter out any notifications currently in the pending-deletion
    // window so a Firestore snapshot does not clobber the optimistic removal.
    unsubscribeFn = subscribeToUserNotifications(
        user.uid,
        (notifications) => {
            // Strip items still pending deletion — they will either be committed
            // (and then genuinely absent from Firestore) or restored via Undo.
            const withoutPending = notifications.filter(n => !_pendingDeletionIds.has(n.id));
            allNotifications = withoutPending;
            syncBadge(withoutPending);
            renderTabs(withoutPending);
            renderList(withoutPending);
            saveNotifCache(withoutPending);
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
    // Commit any pending deletion so it is not silently lost on page unload
    undoToast.commitAll();
});
