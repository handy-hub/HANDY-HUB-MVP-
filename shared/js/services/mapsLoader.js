/**
 * mapsLoader.js — load the Google Maps JavaScript API exactly once.
 *
 * WHY A LOADER AND NOT A <script> TAG
 * ───────────────────────────────────
 * HandyHub is a multi-page app, so every navigation is a fresh document and a
 * fresh load of whatever the page includes. A static <script src="…maps/api/js">
 * in the head would:
 *
 *   • download ~300 KB on pages that never draw a map;
 *   • block first paint on a screen whose job is to render instantly (CLAUDE.md §1);
 *   • give no way to react when the API fails to load, which on a Ghanaian
 *     mobile connection is a routine event, not an edge case.
 *
 * This loads on demand, resolves a promise, and — crucially — REJECTS in a way
 * the caller can render. A map that fails must degrade to an explanation, never
 * to a blank grey rectangle.
 *
 * COST NOTE
 * ─────────
 * Loading the API is what bills a "dynamic map load". Calling this twice on one
 * page would bill twice for one visible map, so the in-flight promise is shared
 * and returned to every caller.
 */

import { MAPS_API_KEY } from '../config/appConfig.js';

let _promise = null;

/** Distinguishes "no key configured" from "Google said no" for honest messaging. */
export const MAPS_ERROR = Object.freeze({
    NO_KEY:    'no-key',
    LOAD_FAIL: 'load-fail',
});

/**
 * Load the Maps JS API.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.libraries]  extra libraries. Keep this MINIMAL — each
 *        one is more bytes over a metered connection. The tracking page needs
 *        none: `places` is already loaded by placesService on the booking form
 *        and is not used here, and `geometry` is unnecessary because Haversine
 *        lives in shared/js/utils/geo.js.
 * @returns {Promise<object>} resolves with `google.maps`
 * @throws  {Error} with `.reason` set to a MAPS_ERROR value
 */
export function loadGoogleMaps(opts = {}) {
    if (_promise) return _promise;

    _promise = new Promise((resolve, reject) => {
        if (typeof window === 'undefined') {
            reject(Object.assign(new Error('No window'), { reason: MAPS_ERROR.LOAD_FAIL }));
            return;
        }

        // Already present (another module loaded it first this page).
        if (window.google && window.google.maps) { resolve(window.google.maps); return; }

        if (!MAPS_API_KEY) {
            reject(Object.assign(
                new Error('Google Maps key is not configured.'),
                { reason: MAPS_ERROR.NO_KEY }));
            return;
        }

        // Use Google's async bootstrap so the script is non-blocking while still
        // preserving the existing key, version, region, and language settings.
        const params = new URLSearchParams({
            key: MAPS_API_KEY,
            v: 'weekly',
            // Ghana. Affects place naming and road rendering conventions.
            region: 'GH',
            language: 'en',
            loading: 'async',
        });
        const libs = Array.isArray(opts.libraries) ? opts.libraries.filter(Boolean) : [];
        if (libs.length) params.set('libraries', libs.join(','));

        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
        s.async = true;
        s.defer = true;

        // Google surfaces auth/referrer/billing failures through this global
        // rather than through script.onerror — without it, a restricted key
        // shows a silent grey box.
        window.gm_authFailure = () => {
            reject(Object.assign(
                new Error('Google Maps rejected this key (referrer, API restriction, or billing).'),
                { reason: MAPS_ERROR.LOAD_FAIL }));
        };

        s.onerror = () => {
            _promise = null;   // allow a later retry after a transient failure
            reject(Object.assign(
                new Error('Google Maps failed to load.'),
                { reason: MAPS_ERROR.LOAD_FAIL }));
        };

        s.onload = async () => {
            const g = window.google && window.google.maps;
            if (!g) {
                reject(Object.assign(
                    new Error('Google Maps loaded but exposed no API.'),
                    { reason: MAPS_ERROR.LOAD_FAIL }));
                return;
            }
            // `loading=async` uses the bootstrap loader: google.maps starts as a
            // stub exposing only importLibrary(), and the constructors —
            // Map, Marker, Polyline, LatLngBounds, SymbolPath — do not exist
            // until a library is imported. Resolving the stub gives callers a
            // namespace where `new maps.Map(...)` throws
            // "Map is not a constructor". Import 'maps' first, then resolve the
            // now-populated namespace.
            // The classic load populates google.maps directly. Any extra
            // libraries requested by the caller are pulled through
            // importLibrary and merged, so a caller asking for e.g. 'geometry'
            // still gets it without a second script tag.
            try {
                let merged = window.google.maps;
                const libs = Array.isArray(opts.libraries) ? opts.libraries : [];
                if (libs.length && typeof g.importLibrary === 'function') {
                    const extra = {};
                    for (const lib of libs) Object.assign(extra, await g.importLibrary(lib));
                    merged = Object.assign(Object.create(null), window.google.maps, extra);
                }
                if (typeof merged.Map !== 'function') {
                    reject(Object.assign(
                        new Error('Google Maps exposed no Map constructor.'),
                        { reason: MAPS_ERROR.LOAD_FAIL }));
                    return;
                }
                resolve(merged);
            } catch (e) {
                reject(Object.assign(
                    new Error('Google Maps library import failed.'),
                    { reason: MAPS_ERROR.LOAD_FAIL }));
            }
        };

        document.head.appendChild(s);
    });

    return _promise;
}

/** Human wording for a map that could not load. Never a blank rectangle. */
export function describeMapFailure(err) {
    if (err && err.reason === MAPS_ERROR.NO_KEY) return 'Map unavailable — not configured.';
    return 'Map could not load. Your booking details below are unaffected.';
}

/** Testing seam. */
export function _resetMapsLoader() { _promise = null; }
