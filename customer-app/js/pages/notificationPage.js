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

let _lastSwipeTime = 0;

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

// ─── Render: single card ──────────────────────────────────────────────────────
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

// ─── Undo-delete toast ────────────────────────────────────────────────────────
/**
 * Manages a single bottom toast for the undo-delete pattern.
 *
 * Only one pending deletion is held at a time. If a second delete arrives
 * while a toast is showing, the first is immediately committed before the
 * new toast is shown.
 *
 * Lifecycle:
 *   show(id, notification, originalIndex, onUndo)
 *     → stores pending state, shows toast, starts 6s timer
 *
 *   timer expires   → _commit()  → calls deleteNotification(id)
 *   user taps Undo  → onUndo(restoreData) is called, toast hides
 *   new delete arrives while pending → _commit() first pending, then show
 *   pagehide        → commitAll() → commits any pending deletion synchronously
 */
const UndoToast = (function () {
    const DURATION_MS = 6000;

    let _pending  = null;  // { id, notification, originalIndex }
    let _timer    = null;
    let _hostEl   = null;
    let _toastEl  = null;

    function _ensureHost() {
        if (_hostEl && _hostEl.isConnected) return;
        _hostEl = document.createElement('div');
        _hostEl.className = 'undo-toast-host';
        _hostEl.setAttribute('aria-live', 'polite');
        _hostEl.setAttribute('aria-atomic', 'true');
        document.body.appendChild(_hostEl);
    }

    function _clearTimer() {
        if (_timer !== null) { clearTimeout(_timer); _timer = null; }
    }

    function _commitPending() {
        if (!_pending) return;
        const { id } = _pending;
        _pending = null;
        _pendingDeletionIds.delete(id);
        // Persist cache now that deletion is final
        saveNotifCache(allNotifications);
        syncBadge(allNotifications);
        updateMarkAllReadBtn();
        deleteNotification(id).catch(err => {
            console.warn('[notifPage] Undo-toast commit failed:', err);
        });
    }

    function _hide(onDone) {
        if (!_toastEl) { onDone?.(); return; }
        _toastEl.classList.remove('is-visible');
        _toastEl.classList.add('is-hiding');
        const el = _toastEl;
        setTimeout(() => {
            if (el.parentNode) el.parentNode.innerHTML = '';
            _toastEl = null;
            onDone?.();
        }, 340);
    }

    /**
     * Show the undo toast for a just-deleted notification.
     *
     * @param {string}   id             Notification Firestore ID
     * @param {object}   notification   The full notification object (for restoration)
     * @param {number}   originalIndex  Position in allNotifications before removal
     * @param {function} onUndo         Callback invoked with restoreData when user taps Undo
     */
    function show(id, notification, originalIndex, onUndo) {
        _ensureHost();

        // If another deletion is already pending, commit it immediately
        if (_pending) {
            _clearTimer();
            _commitPending();
        }

        _pending = { id, notification, originalIndex };
        _pendingDeletionIds.add(id);

        _hostEl.innerHTML = `
            <div class="undo-toast"
                 role="status"
                 aria-label="Notification deleted. Tap Undo to restore.">
                <div class="undo-toast__icon" aria-hidden="true">
                    <i class="fa-solid fa-trash-can"></i>
                </div>
                <span class="undo-toast__msg">Notification deleted</span>
                <button class="undo-toast__undo"
                        type="button"
                        aria-label="Undo: restore deleted notification">
                    Undo
                </button>
                <div class="undo-toast__progress" aria-hidden="true">
                    <div class="undo-toast__progress-fill"
                         style="--toast-duration: ${DURATION_MS}ms"></div>
                </div>
            </div>`;

        _toastEl = _hostEl.querySelector('.undo-toast');

        // Wire the Undo button
        _hostEl.querySelector('.undo-toast__undo').addEventListener('click', () => {
            _clearTimer();
            const restoreData = _pending;
            _pending = null;
            if (restoreData) _pendingDeletionIds.delete(restoreData.id);
            _hide(() => { onUndo?.(restoreData); });
        });

        // Enter animation — double rAF ensures transition fires after paint
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (_toastEl) _toastEl.classList.add('is-visible');
            });
        });

        // Auto-dismiss after DURATION_MS
        _timer = setTimeout(() => {
            _timer = null;
            const toCommit = _pending;
            _pending = null;
            if (toCommit) _pendingDeletionIds.delete(toCommit.id);
            _hide(() => {
                if (!toCommit) return;
                saveNotifCache(allNotifications);
                syncBadge(allNotifications);
                updateMarkAllReadBtn();
                deleteNotification(toCommit.id).catch(err => {
                    console.warn('[notifPage] Auto-commit failed:', err);
                });
            });
        }, DURATION_MS);
    }

    /**
     * Called on pagehide to commit any pending deletion so it is not lost
     * when the page unloads. Uses fire-and-forget since the page is closing.
     */
    function commitAll() {
        _clearTimer();
        if (!_pending) return;
        const { id } = _pending;
        _pending = null;
        _pendingDeletionIds.delete(id);
        saveNotifCache(allNotifications);
        deleteNotification(id).catch(() => {});
    }

    return { show, commitAll };
})();

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
                        // ── Undo-delete: defer Firestore write by DURATION_MS ──
                        initiateDelete(id);
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

    // Update badges + tabs without the deleted item
    syncBadge(allNotifications);
    renderTabs(allNotifications);
    updateMarkAllReadBtn();
    // NOTE: renderList is NOT called here — the DOM row was already removed
    // by the swipe animation. This avoids a jarring re-render.

    UndoToast.show(id, notification, index, (restoreData) => {
        if (!restoreData) return;

        // Re-insert at original position (clamped to current array length)
        const insertAt = Math.min(restoreData.originalIndex, allNotifications.length);
        allNotifications.splice(insertAt, 0, restoreData.notification);

        // Full re-render with restored item + update cache
        syncBadge(allNotifications);
        renderTabs(allNotifications);
        renderList(allNotifications);
        saveNotifCache(allNotifications);
    });
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
    UndoToast.commitAll();
});
