/**
 * presenceService.js — Artisan realtime presence management
 *
 * Responsibilities:
 *  1. Heartbeat every 30 s → writes lastHeartbeat + presenceUpdatedAt to artisans/{uid}
 *  2. Page visibility change → goes offline when hidden, comes back when visible
 *  3. pagehide / beforeunload → marks offline synchronously (best-effort)
 *  4. Online / offline browser events → mirrors network state
 *
 * Usage (in artisan pages that need presence):
 *   import { startPresence, stopPresence } from '../shared/js/services/presenceService.js';
 *
 *   // After auth:
 *   startPresence(uid, databaseService);
 *
 *   // On page unload (optional — handled internally, but call if you manage lifecycle):
 *   stopPresence();
 */

'use strict';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s

let _uid             = null;
let _db              = null;
let _heartbeatTimer  = null;
let _isOnline        = false;
let _started         = false;

/** Write presence fields to Firestore.  Never throws — fire-and-forget. */
async function _writePresence(online) {
    if (!_uid || !_db) return;
    const now = new Date().toISOString();
    try {
        await _db.updateDocument('artisans', _uid, {
            isOnline:           online,
            lastHeartbeat:      now,
            presenceUpdatedAt:  now,
            lastActive:         now,
        });
    } catch (err) {
        // Silently ignore — presence is best-effort
        console.warn('[presenceService] write failed:', err?.message || err);
    }
}

/** Fire a heartbeat pulse without changing the online/offline state. */
async function _heartbeat() {
    if (!_isOnline) return;   // don't heartbeat while intentionally offline
    const now = new Date().toISOString();
    if (!_uid || !_db) return;
    try {
        await _db.updateDocument('artisans', _uid, {
            lastHeartbeat:     now,
            presenceUpdatedAt: now,
        });
    } catch (err) {
        console.warn('[presenceService] heartbeat failed:', err?.message || err);
    }
}

/** Tear down all timers and event listeners. */
function stopPresence() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    window.removeEventListener('online',  _onNetworkOnline);
    window.removeEventListener('offline', _onNetworkOffline);
    window.removeEventListener('pagehide',     _onPageHide);
    window.removeEventListener('beforeunload', _onBeforeUnload);
    _started = false;
}

function _onVisibilityChange() {
    if (document.hidden) {
        _isOnline = false;
        _writePresence(false);
    } else {
        _isOnline = true;
        _writePresence(true);
    }
}

function _onNetworkOnline() {
    if (document.hidden) return;
    _isOnline = true;
    _writePresence(true);
}

function _onNetworkOffline() {
    _isOnline = false;
    _writePresence(false);
}

function _onPageHide() {
    // synchronous best-effort — navigator.sendBeacon would be ideal but
    // Firestore SDK doesn't expose a sync path; this is fire-and-forget.
    _isOnline = false;
    _writePresence(false);
}

function _onBeforeUnload() {
    _isOnline = false;
    _writePresence(false);
}

/**
 * Start presence management for a logged-in artisan.
 *
 * @param {string}  uid              Artisan's Firebase UID
 * @param {object}  databaseService  The shared firebaseDatabaseService instance
 * @param {boolean} [initialOnline=true]  Whether artisan starts as online
 */
async function startPresence(uid, databaseService, initialOnline = true) {
    if (_started) stopPresence();   // restart cleanly if called twice

    _uid      = uid;
    _db       = databaseService;
    _isOnline = initialOnline && navigator.onLine;
    _started  = true;

    // Write initial state immediately
    await _writePresence(_isOnline);

    // Heartbeat every 30 s
    _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_INTERVAL_MS);

    // Visibility changes
    document.addEventListener('visibilitychange', _onVisibilityChange);

    // Network events
    window.addEventListener('online',  _onNetworkOnline);
    window.addEventListener('offline', _onNetworkOffline);

    // Page unload
    window.addEventListener('pagehide',     _onPageHide);
    window.addEventListener('beforeunload', _onBeforeUnload);
}

/**
 * Mark the artisan manually online/offline.
 * Called from the dashboard toggle button (toggleOnlineStatus).
 */
async function setOnlineState(online) {
    _isOnline = online;
    await _writePresence(online);
}

export { startPresence, stopPresence, setOnlineState };
