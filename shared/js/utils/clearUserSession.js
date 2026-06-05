/**
 * clearUserSession.js
 *
 * Single authoritative function for completely wiping all client-side state
 * belonging to the current (or specified) user.
 *
 * Call this BEFORE calling authRepository.signOut() so the uid is still
 * known when constructing scoped key names.
 *
 * What gets cleared:
 *   1. All uid-scoped localStorage keys  (hh_booking_<uid>, etc.)
 *   2. All legacy global localStorage keys (insurance for old sessions)
 *   3. The hh_last_session_uid marker key
 *   4. sessionStorage (booking flow context, auth redirects, etc.)
 *   5. HH_State in-memory uid (window.HH_State.clearUser())
 */

/** Base key names — must stay in sync with stateService.js BASE_KEYS */
const USER_SCOPED_BASES = [
    'hh_booking',
    'hh_booking_history',
    'hh_saved_items',
    'hh_profile_cache',
    'hh_detected_location',
    // service_scores intentionally excluded: device-local click weights should
    // persist across login sessions so the Popular Services ranking is stable.
    'hh_notifications_cache',
    'hh_search_history',
    'hh_search_history_pending',
    'hh_bk_cache',
    'unread_notifications',
    'pref_address',
];

/** Legacy global keys that were never uid-scoped in older sessions */
const LEGACY_GLOBAL_KEYS = [
    'hh_booking',
    'hh_booking_history',
    'hh_saved_items',
    'hh_profile_cache',
    'hh_detected_location',
    // service_scores intentionally excluded: same reason as USER_SCOPED_BASES above.
    'hh_notifications_cache',
    'hh_search_history',
    'hh_search_history_pending',
    'hh_bk_cache',
    'unread_notifications',
    'recentSearches',
    'tracking_recent_searches_v1',
    'pref_address',
];

/**
 * Wipe all user data from client-side storage.
 *
 * @param {string} [uid]  The uid to clear. If omitted, tries window.HH_State.currentUid().
 */
export function clearUserSession(uid) {
    const resolvedUid = uid
        || (window.HH_State && typeof window.HH_State.currentUid === 'function'
            ? window.HH_State.currentUid()
            : null);

    // ── 1. Clear uid-scoped keys ──────────────────────────────────────────────
    if (resolvedUid) {
        USER_SCOPED_BASES.forEach(base => {
            try { localStorage.removeItem(base + '_' + resolvedUid); } catch { /* private mode */ }
        });

        // Sweep any remaining keys that end with _<uid> (catches dynamic keys)
        try {
            const suffix = '_' + resolvedUid;
            Object.keys(localStorage).forEach(k => {
                if (k.endsWith(suffix)) {
                    try { localStorage.removeItem(k); } catch {}
                }
            });
        } catch {}
    }

    // ── 2. Clear legacy global keys (old sessions pre-uid-scoping) ───────────
    LEGACY_GLOBAL_KEYS.forEach(k => {
        try { localStorage.removeItem(k); } catch {}
    });

    // ── 3. Clear the last-session marker ─────────────────────────────────────
    try { localStorage.removeItem('hh_last_session_uid'); } catch {}

    // ── 4. Clear sessionStorage (booking flow, auth redirects, etc.) ─────────
    try { sessionStorage.clear(); } catch {}

    // ── 5. Reset HH_State in-memory uid ──────────────────────────────────────
    if (window.HH_State && typeof window.HH_State.clearUser === 'function') {
        window.HH_State.clearUser();
    }
}
