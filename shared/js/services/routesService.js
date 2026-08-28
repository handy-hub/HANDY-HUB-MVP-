/**
 * routesService.js — real road distance and travel time, via Google Routes API.
 *
 * WHAT THIS REPLACES
 * ──────────────────
 * `estimateEtaMinutes()` in shared/js/utils/geo.js computes:
 *
 *     Haversine straight-line km × 2 minutes/km + 3 minutes buffer
 *
 * That is a straight-line distance wearing a travel time's clothing. In Accra
 * it is wrong in the direction that hurts most: the Korle Lagoon, the Ring Road
 * interchanges and the tolled Tema Motorway all mean two points 4 km apart can
 * be a 35-minute drive. A customer told "~11 min" stands at their door for half
 * an hour and concludes the artisan is lying.
 *
 * COST DISCIPLINE — read before adding a call site
 * ────────────────────────────────────────────────
 * Routes is billed per request, so this module is deliberately awkward to call
 * casually:
 *
 *   • THROTTLED per route. The artisan's phone can write a new position every
 *     few seconds; recomputing the road route each time would bill for every
 *     GPS ping to redraw a number that changes by seconds. One request per
 *     ROUTE_MIN_REFRESH_MS per origin/destination pair, cached in memory.
 *   • COARSE ORIGIN. Origins are rounded to ~110 m before forming the cache key,
 *     so an artisan sitting in traffic reuses one answer instead of buying a new
 *     one each time their GPS jitters.
 *   • CALLER-GATED. Nothing here runs on its own. Call it only while an artisan
 *     is genuinely en route — never for list screens, never for every card.
 *
 * HONESTY ON FAILURE
 * ──────────────────
 * If the key is absent, the API is not enabled, the network fails or no route
 * exists, this returns `null`. It does NOT quietly fall back to the straight-
 * line estimate, because a number the customer cannot distinguish from a real
 * ETA is exactly the failure being removed. The caller decides what to show,
 * and `describeUnavailable()` gives it honest wording.
 */

import { MAPS_API_KEY } from '../config/appConfig.js';

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Minimum spacing between billed Routes requests for the same journey. Traffic
 * does not change meaningfully faster than this, and the artisan's phone emits
 * positions far more often.
 *
 * Deliberately NOT named *_TTL: this is a request-rate floor, not a
 * cache's paintable window. The instant-UX guard governs the latter (a short
 * paint TTL makes a screen shimmer on return visits) and correctly flagged the
 * old name. Nothing here gates a paint — the ETA chip renders immediately and
 * this value only decides when it is worth paying for a fresher number.
 */
const ROUTE_MIN_REFRESH_MS = 90_000;

/** ~110 m. Finer than this buys duplicate answers for GPS jitter. */
const COORD_PRECISION = 3;

const _cache = new Map();   // key -> { at, value }

const round = (n) => Number(n).toFixed(COORD_PRECISION);
const keyFor = (o, d) => `${round(o.lat)},${round(o.lng)}>${round(d.lat)},${round(d.lng)}`;

function valid(p) {
    return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
        && !(Number(p.lat) === 0 && Number(p.lng) === 0);
}

/**
 * Road distance and traffic-aware duration between two points.
 *
 * @param {{lat:number,lng:number}} origin       usually the artisan
 * @param {{lat:number,lng:number}} destination  usually the booking address
 * @param {object}  [opts]
 * @param {boolean} [opts.force]  bypass the throttle (use sparingly)
 * @returns {Promise<{distanceKm:number, durationMinutes:number, source:'routes'}|null>}
 *          null whenever a real answer is not available — never a guess.
 */
export async function getRoadRoute(origin, destination, opts = {}) {
    if (!MAPS_API_KEY) return null;              // not configured — say nothing
    if (!valid(origin) || !valid(destination)) return null;

    const key = keyFor(origin, destination);
    const hit = _cache.get(key);
    if (!opts.force && hit && (Date.now() - hit.at) < ROUTE_MIN_REFRESH_MS) return hit.value;

    const body = {
        origin:      { location: { latLng: { latitude: Number(origin.lat),      longitude: Number(origin.lng) } } },
        destination: { location: { latLng: { latitude: Number(destination.lat), longitude: Number(destination.lng) } } },
        travelMode: 'DRIVE',
        // The whole point of using Routes over Haversine: real congestion.
        routingPreference: 'TRAFFIC_AWARE',
        // Ghana. Keeps units and road rules sane.
        regionCode: 'GH',
        units: 'METRIC',
    };

    let res;
    try {
        res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': MAPS_API_KEY,
                // Field mask is REQUIRED by Routes and is also the cheapest
                // request we can make — asking for the polyline or step-by-step
                // legs moves the call into a higher billing tier for data this
                // screen does not draw.
                'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
            },
            body: JSON.stringify(body),
        });
    } catch (_) {
        return null;                              // offline / blocked
    }

    if (!res.ok) return null;                     // key, restriction, quota, no route

    let json;
    try { json = await res.json(); } catch (_) { return null; }

    const route = json && Array.isArray(json.routes) ? json.routes[0] : null;
    if (!route) return null;                      // genuinely no drivable route

    const meters = Number(route.distanceMeters);
    // Routes returns duration as a protobuf duration string, e.g. "1284s".
    const seconds = Number(String(route.duration || '').replace('s', ''));
    if (!Number.isFinite(meters) || !Number.isFinite(seconds)) return null;

    const value = {
        distanceKm:      Math.round((meters / 1000) * 10) / 10,
        durationMinutes: Math.max(1, Math.round(seconds / 60)),
        source:          'routes',
    };

    _cache.set(key, { at: Date.now(), value });
    return value;
}

/**
 * How to word a missing ETA. Never invent a number here.
 *
 * The old behaviour showed "~12 min" regardless, so a customer could not tell a
 * computed answer from a placeholder. These strings are deliberately not
 * numbers.
 */
export function describeUnavailable(reason = 'unknown') {
    switch (reason) {
        case 'not-en-route':  return 'Not on the way yet';
        case 'no-position':   return 'Waiting for location';
        case 'stale':         return 'Last seen a while ago';
        default:              return 'ETA unavailable';
    }
}

/** Testing seam — the throttle cache is process-local and otherwise invisible. */
export function _resetRouteCache() { _cache.clear(); }
