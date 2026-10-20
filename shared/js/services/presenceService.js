/**
 * presenceService.js — Artisan realtime presence & GPS location management
 *
 * Responsibilities:
 *  1. Online/Offline toggle -> requests GPS and updates location fields
 *  2. Heartbeat every 30 s -> updates lastHeartbeat + presenceUpdatedAt
 *  3. watchPosition tracking -> watches movement, writes coordinate updates
 *  4. Throttling -> only writes location if moved > 15m OR > 5 mins elapsed
 *  5. Self-Healing -> detects device sleep (gap > 45s) and restarts tracking
 *  6. Visibility/Network change -> toggles online/offline automatically
 *  7. pagehide/beforeunload -> synchronously marks offline to prevent stale listings
 *
 * Usage (in artisan pages that need presence):
 *   import { startPresence, stopPresence } from '../shared/js/services/presenceService.js';
 *
 *   // After auth:
 *   startPresence(uid, databaseService, storedOnline, {
 *      onLocationError: (err) => showToast(err.message),
 *      onLocationSuccess: (coords) => console.log(coords)
 *   });
 */

'use strict';

import { getAppContainer } from '../app/container.js';
import { getHaversineDistanceKm } from '../utils/geo.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
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
let _isOnline          = false;
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

/** Write presence and optional coordinates using the repository layer. */
async function _writePresence(online, coords = null) {
    if (!_uid) return;
    if (online && coords) _writeLive(coords);
    try {
        const { repositories: { artisanRepository } } = getAppContainer();
        await artisanRepository.updatePresenceAndLocation(_uid, {
            isOnline: online,
            isAvailable: online,
            latitude: coords ? coords.latitude : null,
            longitude: coords ? coords.longitude : null,
            accuracy: coords ? coords.accuracy : null,
            source: coords ? 'browser_gps' : null
        });
    } catch (err) {
        console.warn('[presenceService] write failed:', err?.message || err);
    }
}

/** Obtain current GPS coordinates wrapped in a Promise. */
function _getCurrentPosition() {
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

/** Handle background position updates and apply write throttling. */
async function _handlePositionUpdate(position) {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = position.coords.accuracy;

    if (accuracy > MAX_ACCURACY_THRESHOLD_METERS) {
        console.warn(`[presenceService] Ignored position update due to low accuracy: ${accuracy}m`);
        return;
    }

    if (!_lastWrittenCoords) {
        _lastWrittenCoords = { latitude: lat, longitude: lng, accuracy, timestamp: Date.now() };
        await _writePresence(true, _lastWrittenCoords);
        if (typeof _options.onLocationSuccess === 'function') {
            _options.onLocationSuccess(_lastWrittenCoords);
        }
        return;
    }

    const distanceKm = getHaversineDistanceKm(
        _lastWrittenCoords.latitude,
        _lastWrittenCoords.longitude,
        lat,
        lng
    );
    const distanceM = distanceKm !== null ? distanceKm * 1000 : 0;
    const timeElapsedMs = Date.now() - _lastWrittenCoords.timestamp;

    if (distanceM > MIN_DISTANCE_THRESHOLD_METERS || timeElapsedMs > MAX_TIME_THRESHOLD_MS) {
        console.log(`[presenceService] Location updated: moved ${distanceM.toFixed(1)}m, elapsed ${(timeElapsedMs/1000).toFixed(0)}s`);
        _lastWrittenCoords = { latitude: lat, longitude: lng, accuracy, timestamp: Date.now() };
        await _writePresence(true, _lastWrittenCoords);
        if (typeof _options.onLocationSuccess === 'function') {
            _options.onLocationSuccess(_lastWrittenCoords);
        }
    }
}

/** Start tracking coordinates with watchPosition. */
function _startWatcher() {
    _stopWatcher();
    if (!navigator.geolocation) return;

    _watchId = navigator.geolocation.watchPosition(
        (position) => {
            _handlePositionUpdate(position);
        },
        (error) => {
            console.warn('[presenceService] watchPosition error:', error.message);
            if (error.code === error.PERMISSION_DENIED) {
                _handleWatchFailure("Location permission revoked. Going offline.");
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
    _lastWrittenCoords = null;
}

/** Handle terminal failures from the GPS watch task. */
async function _handleWatchFailure(message) {
    _isOnline = false;
    _stopWatcher();
    await _writePresence(false);
    if (typeof _options.onLocationError === 'function') {
        _options.onLocationError(new Error(message));
    }
}

/** Pulse a heartbeat to prevent the document from showing stale. */
async function _heartbeat() {
    if (!_isOnline || !_uid) return;

    // Detect sleep recovery
    const nowTime = Date.now();
    const gap = nowTime - _lastHeartbeatTime;
    _lastHeartbeatTime = nowTime;

    if (gap > 45000) {
        console.log('[presenceService] Sleep recovery detected. Re-acquiring location...');
        _recoverLocationState();
        return;
    }

    try {
        const { repositories: { artisanRepository } } = getAppContainer();
        // Fire-and-forget update document timestamps
        await artisanRepository.updatePresenceAndLocation(_uid, {
            isOnline: true,
            isAvailable: true
        });
    } catch (err) {
        console.warn('[presenceService] Heartbeat failed:', err?.message || err);
    }
}

/** Recover Geolocation watcher after sleep or connection drop. */
async function _recoverLocationState() {
    if (!_isOnline) return;
    try {
        const position = await _getCurrentPosition();
        _lastWrittenCoords = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: Date.now()
        };
        await _writePresence(true, _lastWrittenCoords);
        _startWatcher();
    } catch (err) {
        _handleWatchFailure(err.message);
    }
}

/** Tear down all presence schedules and listeners. */
function stopPresence() {
    _stopWatcher();
    if (_activeJobsUnsub) { try { _activeJobsUnsub(); } catch (_) {} _activeJobsUnsub = null; }
    _activeJobIds = [];
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    window.removeEventListener('online',  _onNetworkOnline);
    window.removeEventListener('offline', _onNetworkOffline);
    window.removeEventListener('pagehide',     _onPageHide);
    window.removeEventListener('beforeunload', _onBeforeUnload);
    _started = false;
}

/** Handle Visibility change (offline in bg, online in fg). */
async function _onVisibilityChange() {
    if (document.hidden) {
        _isOnline = false;
        _stopWatcher();
        await _writePresence(false);
        if (typeof _options.onStatusChange === 'function') {
            _options.onStatusChange(false);
        }
    } else {
        _isOnline = true;
        if (typeof _options.onStatusChange === 'function') {
            _options.onStatusChange(true);
        }
        try {
            const position = await _getCurrentPosition();
            _lastWrittenCoords = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                timestamp: Date.now()
            };
            await _writePresence(true, _lastWrittenCoords);
            _startWatcher();
        } catch (err) {
            _handleWatchFailure(err.message);
        }
    }
}

/** Handle network offline. */
async function _onNetworkOffline() {
    _isOnline = false;
    _stopWatcher();
    await _writePresence(false);
    if (typeof _options.onStatusChange === 'function') {
        _options.onStatusChange(false);
    }
}

/** Handle network online. */
async function _onNetworkOnline() {
    if (document.hidden) return;
    _isOnline = true;
    if (typeof _options.onStatusChange === 'function') {
        _options.onStatusChange(true);
    }
    try {
        const position = await _getCurrentPosition();
        _lastWrittenCoords = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: Date.now()
        };
        await _writePresence(true, _lastWrittenCoords);
        _startWatcher();
    } catch (err) {
        _handleWatchFailure(err.message);
    }
}

/** Synchronous pagehide offline trigger. */
function _onPageHide() {
    _isOnline = false;
    _stopWatcher();
    _writePresence(false);
}

/** Synchronous beforeunload offline trigger. */
function _onBeforeUnload() {
    _isOnline = false;
    _stopWatcher();
    _writePresence(false);
}

/** Start presence tracker for logged-in artisan. */
async function startPresence(uid, databaseService, initialOnline = true, options = {}) {
    if (_started) stopPresence();

    _uid               = uid;
    _isOnline          = initialOnline && navigator.onLine;
    _options           = options;
    _started           = true;
    _lastHeartbeatTime = Date.now();

    _watchActiveJobs(databaseService);

    // Setup heartbeat and listeners
    _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_INTERVAL_MS);
    document.addEventListener('visibilitychange', _onVisibilityChange);
    window.addEventListener('online',  _onNetworkOnline);
    window.addEventListener('offline', _onNetworkOffline);
    window.addEventListener('pagehide',     _onPageHide);
    window.addEventListener('beforeunload', _onBeforeUnload);

    if (_isOnline) {
        try {
            const position = await _getCurrentPosition();
            _lastWrittenCoords = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                timestamp: Date.now()
            };
            await _writePresence(true, _lastWrittenCoords);
            _startWatcher();
            if (typeof _options.onLocationSuccess === 'function') {
                _options.onLocationSuccess(_lastWrittenCoords);
            }
        } catch (err) {
            _handleWatchFailure(err.message);
        }
    } else {
        await _writePresence(false);
        _stopWatcher();
    }
}

/** Manually trigger online/offline change. */
async function setOnlineState(online) {
    _isOnline = online;
    if (online) {
        try {
            const position = await _getCurrentPosition();
            _lastWrittenCoords = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                timestamp: Date.now()
            };
            await _writePresence(true, _lastWrittenCoords);
            _startWatcher();
            return _lastWrittenCoords;
        } catch (err) {
            _isOnline = false;
            await _writePresence(false);
            _stopWatcher();
            throw err;
        }
    } else {
        _stopWatcher();
        await _writePresence(false);
    }
}

export { startPresence, stopPresence, setOnlineState };
