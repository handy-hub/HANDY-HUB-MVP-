// ─────────────────────────────────────────────────────────────────────────────
// settingsSync.js — realtime two-way sync of app preferences between
//                   localStorage (for instant paint) and Firestore
//                   (for cross-device persistence).
//
// Stored at: customers/{uid}.appPreferences
//   { theme: 'Light'|'Dark', currency: 'GHC'|'USD'|…, language: 'English'|… }
//
// Usage:
//   import { initSettingsSync, saveAppPreference } from '../utils/settingsSync.js';
//   initSettingsSync(authService, databaseService);   // once on startup
//   await saveAppPreference('theme', 'Dark');          // on user change
// ─────────────────────────────────────────────────────────────────────────────

const PREF_KEYS = ['theme', 'currency', 'language', 'address'];

let _unsubscribe = null;
let _uid         = null;
let _db          = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start realtime settings sync.
 * Call once after app boot — subscribes to the customer doc and mirrors
 * any appPreferences changes into localStorage + live UI.
 *
 * @param {object} authService
 * @param {object} databaseService
 */
export function initSettingsSync(authService, databaseService) {
    _db = databaseService;

    authService.subscribeToAuthState((user) => {
        if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
        if (!user) { _uid = null; return; }

        _uid = user.uid;

        _unsubscribe = databaseService.subscribeToDocument('customers', user.uid, (snap) => {
            if (!snap.exists) return;
            const prefs = snap.data?.appPreferences || {};
            _applyFromFirestore(prefs);
        });
    });
}

/**
 * Persist a single app preference to localStorage immediately AND to Firestore
 * (merge). Use this whenever the user changes a setting so it syncs
 * across devices.
 *
 * @param {string} key   — one of 'theme' | 'currency' | 'language'
 * @param {string} value
 */
export async function saveAppPreference(key, value) {
    localStorage.setItem('pref_' + key, value);
    if (!_uid || !_db) return; // not signed in yet — localStorage is enough

    try {
        await _db.setDocument(
            'customers',
            _uid,
            { appPreferences: { [key]: value }, updatedAt: new Date().toISOString() },
            { merge: true }
        );
    } catch (err) {
        console.warn('[settingsSync] Firestore write failed:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply preferences coming in from a Firestore snapshot.
 * Only updates localStorage / UI when the remote value differs from what's
 * already stored — avoids clobbering a very recent user gesture.
 */
function _applyFromFirestore(prefs) {
    for (const key of PREF_KEYS) {
        const remote = prefs[key];
        if (remote === undefined || remote === null) continue;

        const local = localStorage.getItem('pref_' + key);
        if (local === remote) continue; // nothing to do

        localStorage.setItem('pref_' + key, remote);
        _applySideEffect(key, remote);
    }
}

/**
 * Trigger any live UI changes when a preference is updated at runtime.
 */
function _applySideEffect(key, value) {
    if (key === 'theme') {
        // applyTheme() is the global function exported from themeManager.js
        if (typeof applyTheme === 'function') {
            applyTheme(value);
        } else {
            // Fallback in pages that don't include themeManager.js
            const root = document.documentElement;
            if (value === 'Dark') {
                root.setAttribute('data-theme', 'dark');
                root.classList.add('dark');
                root.style.colorScheme = 'dark';
            } else {
                root.removeAttribute('data-theme');
                root.classList.remove('dark');
                root.style.colorScheme = 'light';
            }
        }
        // Update the settings display text if we're on settings.html
        const el = document.getElementById('theme-display');
        if (el) el.textContent = value;
    }
    // currency / language changes take effect on the next page load —
    // no runtime DOM update needed beyond persisting to localStorage.
}
