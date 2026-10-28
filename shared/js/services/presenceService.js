/**
 * presenceService.js — artisan presence, GPS location, and the explicit
 * availability switch.
 *
 * Availability (isAvailable / isOnline) is the artisan's CHOICE and changes in
 * exactly one place: setAvailability(), called from a "Go Online" / "Go Offline"
 * control. Nothing else in this file writes it. See shared/js/domain/availability.js
 * for why: page lifecycle used to write it, so leaving the dashboard took the
 * artisan out of dispatch and opening it put them back (audit FLOW-001/002).
 *
 * What presence does do:
 *  1. Heartbeat every 30 s while the page is visible and the artisan is
 *     available → lastHeartbeat / presenceUpdatedAt / lastActive.
 *  2. watchPosition while available (dispatch distance) or while a job is
 *     en_route / in_progress (the customer's live map) → location writes,
 *     throttled to > 15 m moved or > 5 min elapsed.
 *  3. Pauses GPS when the tab is hidden, the network drops or the page unloads,
 *     and resumes it when they come back. None of these change availability.
 *
 * Usage (artisan pages that track location):
 *   import { startPresence, stopPresence, syncAvailability, setAvailability }
 *     from '../shared/js/services/presenceService.js';
 *   startPresence(uid, databaseService, artisan.isAvailable === true, {
 *     onLocationError: (err) => showToast(err.message),
 *   });
 *   // on every live artisans/{uid} snapshot:
 *   syncAvailability(snap.data.isAvailable === true);
 *   // on a Go Online / Go Offline tap:
 *   await setAvailability(uid, true, { artisan });
 */

'use strict';

import { getAppContainer } from '../app/container.js';
import { getHaversineDistanceKm } from '../utils/geo.js';
import { availabilityBlocker, createAvailabilityQueue } from '../domain/availability.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
// The heartbeat WRITE is throttled to the liveness bucket the server keeps
// (functions/artisanIndex.js LIVENESS_BUCKET_MS): more often would cost a
// profile write + trigger run every 30 s per artisan and tell dispatch nothing.
const HEARTBEAT_WRITE_MS    = 5 * 60 * 1000;
// Every navigation is a new document, so the time of the last write is kept
// for the tab — otherwise each page view would send its own heartbeat.
const HEARTBEAT_MARK        = 'fx_presence_last_heartbeat';
function _lastHeartbeatWrite(uid) {
    try { const m = JSON.parse(sessionStorage.getItem(HEARTBEAT_MARK) || 'null'); return m && m.uid === uid ? Number(m.ms) || 0 : 0; }
    catch (_) { return 0; }
}
function _markHeartbeatWrite(uid, ms) {
    try { sessionStorage.setItem(HEARTBEAT_MARK, JSON.stringify({ uid, ms })); } catch (_) { /* storage blocked */ }
}
const GEOLOCATION_OPTIONS = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 30000
};
const MIN_DISTANCE_THRESHOLD_METERS = 15;
const MAX_TIME_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_ACCURACY_THRESHOLD_METERS = 100;

let _uid               = null;
let _watchId           = null;
let _heartbeatTimer    = null;
let _available         = false;  // the artisan's stored choice, as last confirmed
let _started           = false;
let _lastWrittenCoords = null; // { latitude, longitude, accuracy, timestamp }
let _lastHeartbeatTime = Date.now();
let _options           = {};   // callbacks: onLocationError, onLocationSuccess

// ── Live position for the artisan's ACTIVE jobs ───────────────────────────────
// The customer's live map reads bookings/{id}/live/artisan, which firestore.rules
// let only that booking's artisan write and only its customer (and artisan) read,
// and only while the job is en_route or in_progress. So the precise position
// reaches exactly one audience — the customer the artisan is driving to — and
// stops reaching them the moment the job moves on. The public profile carries a
// ~1 km position only (see shared/js/domain/locationPrivacy.js).
let _activeJobIds    = [];
let _activeJobsUnsub = null;

function _watchActiveJobs(databaseService) {
    if (_activeJobsUnsub || !_uid || !databaseService || typeof databaseService.subscribeToCollection !== 'function') return;
    try {
        _activeJobsUnsub = databaseService.subscribeToCollection(
            'bookings',
            [{ field: 'artisanId', op: '==', value: _uid },
             { field: 'status',    op: 'in', value: ['en_route', 'in_progress'] }],
            {},
            (records) => {
                const next  = (records || []).map((r) => r.id);
                const added = next.filter((id) => !_activeJobIds.includes(id));
                _activeJobIds = next;
                // A job that just started gets the last known fix at once.
                if (added.length && _lastWrittenCoords) _writeLive(_lastWrittenCoords, added);
                _retrack();
            },
            (err) => console.warn('[presenceService] active-jobs subscription failed:', err?.message || err)
        );
    } catch (err) {
        console.warn('[presenceService] active-jobs subscription failed:', err?.message || err);
    }
}

async function _writeLive(coords, ids = _activeJobIds) {
    if (!coords || !_uid || !ids.length) return;
    const { services: { databaseService } } = getAppContainer();
    await Promise.all(ids.map((id) => databaseService.setDocument(`bookings/${id}/live`, 'artisan', {
        artisanId: _uid,
        lat:       coords.latitude,
        lng:       coords.longitude,
        accuracy:  typeof coords.accuracy === 'number' ? coords.accuracy : null,
        updatedAt: new Date().toISOString(),
    }).catch((err) => console.warn('[presenceService] live position write failed:', err?.message || err))));
}

/**
 * Write a new position: to the customer's live map for active jobs, and — only
 * while the artisan is available — to their profile location for dispatch.
 * Never writes isAvailable / isOnline.
 */
async function _writeLocation(coords) {
    if (!_uid || !coords) return;
    _writeLive(coords);
    if (!_available) return;
    try {
        const { repositories: { artisanRepository } } = getAppContainer();
        await artisanRepository.updatePresenceAndLocation(_uid, {
            latitude:  coords.latitude,
            longitude: coords.longitude,
            accuracy:  coords.accuracy,
            source:    'browser_gps',
        });
    } catch (err) {
        console.warn('[presenceService] location write failed:', err?.message || err);
    }
}

/** Resolve with `fallback()` if `promise` has not settled within `ms`. */
function _within(promise, ms, fallback) {
    let timer;
    const guard = new Promise((resolve, reject) => {
        timer = setTimeout(() => { try { resolve(fallback()); } catch (e) { reject(e); } }, ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const GPS_GUARD_MS   = 12_000;   // getCurrentPosition's own timeout does not always fire
const WRITE_GUARD_MS = 15_000;   // a write is acknowledged only once Firestore is connected

/** Obtain current GPS coordinates wrapped in a Promise. Always settles. */
function _getCurrentPosition() {
    return _within(_rawPosition(), GPS_GUARD_MS, () => {
        throw new Error('Location retrieval timed out. Please try again or move to an open space.');
    });
}

function _rawPosition() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Geolocation is not supported by this browser."));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                if (position.coords.accuracy > MAX_ACCURACY_THRESHOLD_METERS) {
                    reject(new Error(`Low GPS accuracy: ${Math.round(position.coords.accuracy)}m. Please move to an open area.`));
                } else {
                    resolve(position);
                }
            },
            (error) => {
                let msg = "Failed to acquire location.";
                switch (error.code) {
                    case error.PERMISSION_DENIED:
                        msg = "Location permission was denied. Please allow location access to go online.";
                        break;
                    case error.POSITION_UNAVAILABLE:
                        msg = "GPS location service is unavailable. Please check if your device's location services are enabled.";
                        break;
                    case error.TIMEOUT:
                        msg = "Location retrieval timed out. Please try again or move to an open space.";
                        break;
                }
                reject(new Error(msg));
            },
            GEOLOCATION_OPTIONS
        );
    });
}

const _toCoords = (position) => ({
    latitude:  position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy:  position.coords.accuracy,
    timestamp: Date.now(),
});

/** Handle background position updates and apply write throttling. */
async function _handlePositionUpdate(position) {
    const accuracy = position.coords.accuracy;
    if (accuracy > MAX_ACCURACY_THRESHOLD_METERS) {
        console.warn(`[presenceService] Ignored position update due to low accuracy: ${accuracy}m`);
        return;
    }

    if (_lastWrittenCoords) {
        const distanceKm = getHaversineDistanceKm(
            _lastWrittenCoords.latitude, _lastWrittenCoords.longitude,
            position.coords.latitude, position.coords.longitude
        );
        const distanceM = distanceKm !== null ? distanceKm * 1000 : 0;
        const timeElapsedMs = Date.now() - _lastWrittenCoords.timestamp;
        if (distanceM <= MIN_DISTANCE_THRESHOLD_METERS && timeElapsedMs <= MAX_TIME_THRESHOLD_MS) return;
    }

    _lastWrittenCoords = _toCoords(position);
    await _writeLocation(_lastWrittenCoords);
    if (typeof _options.onLocationSuccess === 'function') {
        _options.onLocationSuccess(_lastWrittenCoords);
    }
}

/** Start tracking coordinates with watchPosition. */
function _startWatcher() {
    if (_watchId !== null || !navigator.geolocation) return;
    _watchId = navigator.geolocation.watchPosition(
        (position) => { _handlePositionUpdate(position); },
        (error) => {
            console.warn('[presenceService] watchPosition error:', error.message);
            if (error.code === error.PERMISSION_DENIED) {
                _stopWatcher();
                if (typeof _options.onLocationError === 'function') {
                    _options.onLocationError(new Error(
                        'Location access was turned off. Jobs are matched to your last known location until you allow it again.'));
                }
            }
        },
        GEOLOCATION_OPTIONS
    );
}

/** Stop watching coordinate changes. */
function _stopWatcher() {
    if (_watchId !== null) {
        navigator.geolocation.clearWatch(_watchId);
        _watchId = null;
    }
}

/** Whether GPS should be running now: someone needs the position and we can send it. */
function _shouldTrack() {
    if (!_started || !_uid) return false;
    if (_options && _options.trackLocation === false) return false;   // heartbeat-only page
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return _available || _activeJobIds.length > 0;
}

/** Start or stop the watcher to match _shouldTrack(). Writes nothing by itself. */
function _retrack() {
    if (_shouldTrack()) _startWatcher();
    else _stopWatcher();
}

/** Refresh the presence timestamps. Never writes availability. */
async function _heartbeat() {
    if (!_available || !_uid) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    // Detect sleep recovery: the watcher may have died with the device.
    const nowTime = Date.now();
    const gap = nowTime - _lastHeartbeatTime;
    _lastHeartbeatTime = nowTime;
    if (gap > 45000) {
        console.log('[presenceService] Sleep recovery detected. Restarting location tracking.');
        _stopWatcher();
        _retrack();
    }

    const uid = _uid;
    const previous = _lastHeartbeatWrite(uid);
    if (nowTime - previous < HEARTBEAT_WRITE_MS) return;
    _markHeartbeatWrite(uid, nowTime);
    try {
        const { repositories: { artisanRepository } } = getAppContainer();
        await artisanRepository.updatePresenceAndLocation(uid, {});
    } catch (err) {
        _markHeartbeatWrite(uid, previous);   // try again on the next beat
        console.warn('[presenceService] Heartbeat failed:', err?.message || err);
    }
}

// Lifecycle: pause or resume GPS. Availability is NOT touched — a hidden tab,
// a dropped connection or a page navigation is not the artisan going offline.
function _onVisibilityChange() { _retrack(); if (!document.hidden) _heartbeat(); }
function _onNetworkOffline()   { _retrack(); }
function _onNetworkOnline()    { _retrack(); _heartbeat(); }
function _onPageHide()         { _stopWatcher(); }

/** Tear down all presence schedules and listeners. */
function stopPresence() {
    _stopWatcher();
    if (_activeJobsUnsub) { try { _activeJobsUnsub(); } catch (_) {} _activeJobsUnsub = null; }
    _activeJobIds = [];
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    window.removeEventListener('online',  _onNetworkOnline);
    window.removeEventListener('offline', _onNetworkOffline);
    window.removeEventListener('pagehide', _onPageHide);
    _started = false;
}

/**
 * Start presence for a signed-in artisan.
 * @param {string}  uid
 * @param {object}  databaseService
 * @param {boolean} available  the artisan's STORED choice (artisans/{uid}.isAvailable === true)
 * @param {object}  options    { onLocationError, onLocationSuccess }
 */
function startPresence(uid, databaseService, available = false, options = {}) {
    if (_started) stopPresence();

    _uid               = uid;
    _available         = !!available;
    _options           = options;
    _started           = true;
    _lastHeartbeatTime = Date.now();
    _lastWrittenCoords = null;

    _watchActiveJobs(databaseService);

    _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_INTERVAL_MS);
    document.addEventListener('visibilitychange', _onVisibilityChange);
    window.addEventListener('online',  _onNetworkOnline);
    window.addEventListener('offline', _onNetworkOffline);
    window.addEventListener('pagehide', _onPageHide);

    _retrack();
    _heartbeat();
}

/**
 * Tell presence the stored choice changed (a live snapshot, another tab, an
 * admin suspension). Adjusts GPS tracking; writes nothing.
 */
function syncAvailability(available) {
    _available = !!available;
    _retrack();
}

// ── The explicit switch ───────────────────────────────────────────────────────
const _queue = createAvailabilityQueue({
    acquirePosition: async () => _toCoords(await _getCurrentPosition()),
    write: async (available, coords) => {
        const uid = _pendingUid;
        if (!uid) throw new Error('Not signed in.');
        const { repositories: { artisanRepository } } = getAppContainer();
        // The write is applied locally at once; its promise settles only when the
        // server acknowledges it. Offline or reconnecting, that can take minutes,
        // so after WRITE_GUARD_MS the change is reported as saved-and-queued
        // instead of leaving the switch spinning. A rejection still surfaces.
        const ack = artisanRepository.updatePresenceAndLocation(uid, {
            isOnline:    available,
            isAvailable: available,
            ...(coords ? { latitude: coords.latitude, longitude: coords.longitude,
                           accuracy: coords.accuracy, source: 'browser_gps' } : {}),
        });
        const confirmed = await _within(ack.then(() => true), WRITE_GUARD_MS, () => false);
        ack.catch((err) => console.warn('[presenceService] availability write failed:', err?.message || err));
        if (uid === _uid) {
            _available = available;
            if (coords) { _lastWrittenCoords = coords; _writeLive(coords); }
            _retrack();
        }
        // Keep the guard's cached verdict in step, so the next page paints it.
        try { window._agPatchSession?.({ isAvailable: available, isOnline: available }); } catch (_) {}
        return { queued: !confirmed };
    },
});
let _pendingUid = null;

/**
 * The artisan's explicit Go Online / Go Offline. Going online needs a GPS fix
 * and an eligible account; going offline always goes through. Requests are
 * serialised and the last one wins (see createAvailabilityQueue).
 *
 * Works on any page — presence need not be started.
 *
 * @param {string}  uid
 * @param {boolean} available
 * @param {{ artisan?: object }} [opts]  the live profile, for the eligibility check
 * @returns {Promise<{ ok: boolean, superseded: boolean, available: boolean }>}
 *          rejects with a user-facing Error when it could not be saved
 */
async function setAvailability(uid, available, { artisan } = {}) {
    if (!uid) throw new Error('Not signed in.');
    if (available && artisan !== undefined) {
        const blocker = availabilityBlocker(artisan);
        if (blocker) throw Object.assign(new Error(blocker.message), { reason: blocker.reason });
    }
    _pendingUid = uid;
    return _queue.request(!!available);
}

/** Whether an availability change is still being saved. */
function availabilityPending() { return _queue.busy; }

/** @deprecated use setAvailability(uid, online, { artisan }). */
async function setOnlineState(online) {
    return setAvailability(_uid, online);
}

/**
 * Heartbeat-only presence for pages that do not track location (wallet,
 * settings, …), started by the floating nav. A page that has already started
 * full presence (dashboard, jobs) keeps it; this never downgrades it.
 */
function ensurePresence(uid, databaseService, available) {
    if (_started && _uid === uid) { syncAvailability(available); return; }
    startPresence(uid, databaseService, available, { trackLocation: false });
}

export { startPresence, stopPresence, syncAvailability, setAvailability, availabilityPending, setOnlineState, ensurePresence };
