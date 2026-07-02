/**
 * promotionService.js
 *
 * Firestore-driven promotion (ad banner) data source, image resolution,
 * lightweight targeting, and non-blocking analytics — replacing the
 * hardcoded BANNER_DATA array in customer-app/js/adBanner.js.
 *
 * SAFETY CONTRACT: loadActivePromotions() NEVER throws. It always resolves
 * to a PromotionLoadResult — an explicit { status, data, reason } object
 * (see PromotionLoadResult below) rather than an ambiguous bare array, so a
 * caller can tell "Firestore has zero active promotions" apart from
 * "Firestore couldn't be reached" without inspecting error internals.
 * Both cases still mean the same thing to the UI layer (fall back to
 * BANNER_DATA) — the distinction exists for logging/debugging, not for any
 * different rendering path.
 *
 * Collection: "promotions"
 *   { id, content:{title,subtitle,cta}, media:{imageKey},
 *     action:{type,value}, targeting:{cities,serviceTypes,newUsersOnly},
 *     schedule:{start,end,priority}, analytics:{impressions,clicks}, status }
 *   analytics.impressions/clicks on THIS document are DISPLAY ONLY — an
 *   admin-authored/seeded snapshot, if present at all. The client never
 *   reads or writes these fields; see getPromotionMetrics() below for the
 *   real, live counters.
 *
 * Collection: "promotionAnalytics/{promoId}"  ← SINGLE SOURCE OF TRUTH
 *   { impressions: number, clicks: number, updatedAt }
 *   Written via FieldValue.increment(1) only — see firestore.rules for the
 *   exact-+1 enforcement. Read via getPromotionMetrics() only.
 */

import { getAppContainer } from '../app/container.js';
import { cdnUrl } from './cloudinaryService.js';
import { doc, getDoc, setDoc, increment, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { firebaseDb }
    from '../backend/providers/firebase/firebaseConfig.js';

const PROMOTIONS_COLLECTION = 'promotions';
const ANALYTICS_COLLECTION  = 'promotionAnalytics';
const MAX_RESULTS           = 3;

// NOTE: there is currently NO real fallback image uploaded to Cloudinary.
// A prior version of this file pointed resolveImage() at a nonexistent
// "promotions/fallback/default_promo" key, which cost every banner render a
// real ~1.5s failed network round-trip to Cloudinary before the slide's
// solid-color background showed. resolveImage() now returns null instead —
// adBanner.js skips rendering an <img> entirely when there's no real key, so
// the slide's --img-fallback color shows immediately with zero wasted
// requests. If/when a real fallback image is uploaded to Cloudinary, set
// FALLBACK_IMAGE_KEY below to its public_id to re-enable this path.
const FALLBACK_IMAGE_KEY    = null;

/* ── Load ──────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} PromotionLoadResult
 * @property {"success"|"empty"|"error"} status
 * @property {Array<{id: string, data: object}>} data  raw Firestore records (always [] unless status === "success")
 * @property {"network"|"no_docs"|"filtered_out"|null} reason
 */

/**
 * Fetch all active promotions from Firestore. NEVER throws — any failure
 * resolves to an explicit { status: "error", reason: "network" } result
 * instead of propagating the exception, so callers never need a try/catch.
 * @returns {Promise<PromotionLoadResult>}
 */
export async function loadActivePromotions() {
    let records;
    try {
        const { services } = getAppContainer();
        records = await services.databaseService.queryWithOptions(
            PROMOTIONS_COLLECTION,
            [{ field: 'status', op: '==', value: 'active' }],
            {}
        );
    } catch (err) {
        console.warn('[promotionService] loadActivePromotions failed:', err.message);
        return { status: 'error', data: [], reason: 'network' };
    }

    if (!Array.isArray(records) || records.length === 0) {
        return { status: 'empty', data: [], reason: 'no_docs' };
    }
    return { status: 'success', data: records, reason: null };
}

/* ── Image resolution ─────────────────────────────────────────────────── */

/**
 * Resolve a promotion's Cloudinary imageKey to a CDN URL, or null if there's
 * no real key to resolve. Deliberately does NOT synthesize a URL for a
 * nonexistent fallback image — see FALLBACK_IMAGE_KEY above. Callers (see
 * adaptPromotion() in adBanner.js) must treat a null return as "render this
 * slide with its solid-color background, no <img> element at all" rather
 * than attempting to load a URL that's known not to resolve.
 *
 * NOTE: on-the-fly Cloudinary transforms are currently 404-ing for every
 * derived request on this account/plan (same issue documented in
 * cloudinaryService.js's avatarUrl()). Once a real fallback/promo image
 * pipeline exists, use an empty transform (untransformed original) until
 * that's resolved — CSS (.slide-img-wrap img { object-fit:cover }) already
 * handles the crop client-side.
 * @param {string} imageKey  e.g. "promotions/cleaning/accra_cleaning_v1"
 * @returns {string|null}
 */
export function resolveImage(imageKey) {
    const key = (typeof imageKey === 'string' && imageKey.trim()) ? imageKey.trim() : null;
    if (key) return cdnUrl(key, '');
    return FALLBACK_IMAGE_KEY ? cdnUrl(FALLBACK_IMAGE_KEY, '') : null;
}

/* ── Resolver (lightweight targeting) ─────────────────────────────────── */

/**
 * Filter + target + sort + cap a raw promotions list for one user.
 * Deliberately simple: no scoring, no ML — status match, then three
 * optional AND'd targeting checks, then priority sort, then slice(0,3).
 *
 * @param {{ location?: string, bookings?: number } | null} user
 *   Minimal shape read from the customer doc — location is free text
 *   (matched case-insensitively as a substring against targeting.cities),
 *   bookings is the server-incremented lifetime booking count (0 = new user).
 * @param {Array<{id: string, data: object}>} promotions  raw Firestore records
 * @returns {Array<object>} up to 3 promotion data objects (id attached), highest priority first
 */
export function resolvePromotions(user, promotions) {
    const now = Date.now();

    const eligible = (promotions || []).filter(({ data }) => {
        if (!data || data.status !== 'active') return false;

        const schedule = data.schedule || {};
        if (schedule.start && now < toMillis(schedule.start)) return false;
        if (schedule.end   && now > toMillis(schedule.end))   return false;

        const targeting = data.targeting || {};
        if (Array.isArray(targeting.cities) && targeting.cities.length > 0) {
            const userLocation = (user?.location || '').toLowerCase();
            const matchesCity = targeting.cities.some(c => userLocation.includes(String(c).toLowerCase()));
            if (!matchesCity) return false;
        }
        if (Array.isArray(targeting.serviceTypes) && targeting.serviceTypes.length > 0) {
            const userServiceTypes = (user?.serviceTypes || []).map(s => String(s).toLowerCase());
            const matchesService = targeting.serviceTypes.some(s => userServiceTypes.includes(String(s).toLowerCase()));
            if (!matchesService) return false;
        }
        if (targeting.newUsersOnly === true) {
            const isNewUser = !user || (user.bookings ?? 0) === 0;
            if (!isNewUser) return false;
        }

        return true;
    });

    eligible.sort((a, b) => (b.data.schedule?.priority ?? 0) - (a.data.schedule?.priority ?? 0));

    return eligible.slice(0, MAX_RESULTS).map(({ id, data }) => ({ id, ...data }));
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    if (typeof value?.toMillis === 'function') return value.toMillis(); // Firestore Timestamp
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/* ── Analytics (non-blocking, fail-silent) ────────────────────────────── */

/**
 * Record an impression for a promotion. Fire-and-forget: never awaited by
 * callers, never throws, never blocks rendering.
 */
export function trackPromotionImpression(promoId) {
    _incrementCounter(promoId, 'impressions');
}

/**
 * Record a click for a promotion. Fire-and-forget: never awaited by
 * callers, never throws, never blocks navigation.
 */
export function trackPromotionClick(promoId) {
    _incrementCounter(promoId, 'clicks');
}

function _incrementCounter(promoId, field) {
    if (!promoId) return;
    try {
        const ref = doc(firebaseDb, ANALYTICS_COLLECTION, promoId);
        setDoc(ref, { [field]: increment(1), updatedAt: serverTimestamp() }, { merge: true })
            .catch(err => console.warn(`[promotionService] ${field} tracking failed (non-fatal):`, err.message));
    } catch (err) {
        console.warn(`[promotionService] ${field} tracking failed (non-fatal):`, err.message);
    }
}

/**
 * Read the real impression/click counters for a promotion. This is the
 * ONLY place in the app that reads promotionAnalytics — promotions.analytics
 * (the field on the promotion document itself) is never read by client code
 * and must never be treated as authoritative.
 *
 * Fails silently: a missing document, a permission-denied read (the
 * collection is admin-read-only per firestore.rules), or any other error
 * all resolve to the same zeroed shape rather than throwing.
 *
 * @param {string} promoId
 * @returns {Promise<{impressions: number, clicks: number}>}
 */
export async function getPromotionMetrics(promoId) {
    const empty = { impressions: 0, clicks: 0 };
    if (!promoId) return empty;
    try {
        const snap = await getDoc(doc(firebaseDb, ANALYTICS_COLLECTION, promoId));
        if (!snap.exists()) return empty;
        const data = snap.data();
        return {
            impressions: typeof data.impressions === 'number' ? data.impressions : 0,
            clicks:      typeof data.clicks      === 'number' ? data.clicks      : 0,
        };
    } catch (err) {
        console.warn('[promotionService] getPromotionMetrics failed (non-fatal):', err.message);
        return empty;
    }
}
