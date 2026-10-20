/**
 * locationPrivacy.js — how precisely an artisan's position may be published.
 *
 * artisans/{uid} is readable by every signed-in account, and anyone can open a
 * customer account, so whatever position sits on it is public. Until 2026-10-20
 * presence wrote the phone's high-accuracy GPS there every few seconds of
 * movement (currentLat/currentLng, lat/lng, geohash): a stranger could follow an
 * online artisan in real time, home included.
 *
 * Now there are three places, each with its own audience:
 *
 *   artisans/{uid}                      PUBLIC — coarse only (this module):
 *                                       ~1.1 km coordinates, ~4.9 km geohash.
 *                                       Enough for "about 3 km away" in search.
 *   artisans/{uid}/private/location     the artisan + admins — precise. Copied by
 *                                       syncArtisanIndex into artisan_index, which
 *                                       only Cloud Functions read (dispatch,
 *                                       travel-fee pricing).
 *   bookings/{id}/live/artisan          the booking's customer + artisan, ONLY while
 *                                       the job is en_route / in_progress — the
 *                                       live map. Gone the moment the job moves on.
 *
 * firestore.rules enforces the coarse precision on the public document
 * (isCoarseCoord), so a client that ignores this module is refused.
 *
 * Pure (no imports): shared by artisanRepository, onboarding, and tests.
 * functions/contactPrivacy.js mirrors coarseCoord for the migration.
 */

/** Decimal places kept on public coordinates: 0.01° ≈ 1.1 km. */
export const PUBLIC_COORD_DECIMALS = 2;

/** Characters kept on the public geohash: 5 ≈ a 4.9 km × 4.9 km cell. */
export const PUBLIC_GEOHASH_LENGTH = 5;

/** A coordinate rounded to public precision, or null when it is not a number. */
export function coarseCoord(v) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
}

/** A geohash cut to public precision, or null. */
export function coarseGeohash(hash) {
    return typeof hash === 'string' && hash.length ? hash.slice(0, PUBLIC_GEOHASH_LENGTH) : null;
}

/**
 * The public location fields for a precise position. `geohashFor` computes a
 * full geohash; the public copy is derived from the COARSE point and then cut,
 * so it carries no more precision than the coordinates beside it.
 *
 * @returns {{lat:number, lng:number, latitude:number, longitude:number, geohash:string|null}|null}
 */
export function publicLocation(lat, lng, geohashFor = null) {
    const cLat = coarseCoord(lat), cLng = coarseCoord(lng);
    if (cLat === null || cLng === null) return null;
    let geohash = null;
    try { geohash = typeof geohashFor === 'function' ? coarseGeohash(geohashFor(cLat, cLng)) : null; } catch (_) {}
    return { lat: cLat, lng: cLng, latitude: cLat, longitude: cLng, geohash };
}

/** True when a value already has no more than public precision. */
export function isCoarse(v) {
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}
