/**
 * artisanRepository.js
 *
 * Collection: "artisans"
 * Document ID: Firebase Auth UID of the artisan
 *
 * Schema
 * ──────
 * name                  string
 * specialty             string      e.g. "Plumber"
 * category              string      e.g. "Plumbing"
 * location              string      e.g. "Accra, Ghana"
 * profileImage          string | null   (Storage download URL)
 * bio                   string
 * phone                 string
 * rating                number      0–5, updated after each review
 * reviewCount           number
 * jobsCompleted         number
 * isAvailable           boolean
 * searchKeywords        string[]    built by searchKeywordSeeder
 * commonSearchPhrases   string[]    extra synonyms for the seeder
 * createdAt             string      (ISO timestamp)
 * updatedAt             string      (ISO timestamp)
 *
 * Required Firestore indexes
 * ──────────────────────────
 * 1. searchKeywords      — single-field array-contains (auto-created)
 * 2. category ASC, rating DESC   — composite
 * 3. isAvailable ASC, rating DESC — composite
 */

const DEFAULT_COLLECTION = "artisans";

function now() {
    return new Date().toISOString();
}

// Lightweight geohash encoder — no external dependency, works in browser + Node.
// Precision 6 → ~1.2 km × 0.6 km cells. Dispatch queries at precision ~4-5
// (auto-selected by geofire-common based on search radius), so storing at 6
// gives full resolution while remaining compatible with any search radius.
function _geohashForPoint(lat, lng, precision = 6) {
    const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
    let hash = '', bit = 0, even = true, ch = 0;
    while (hash.length < precision) {
        if (even) {
            const mid = (minLng + maxLng) / 2;
            if (lng >= mid) { ch = (ch << 1) | 1; minLng = mid; }
            else            { ch <<= 1;            maxLng = mid; }
        } else {
            const mid = (minLat + maxLat) / 2;
            if (lat >= mid) { ch = (ch << 1) | 1; minLat = mid; }
            else            { ch <<= 1;            maxLat = mid; }
        }
        even = !even;
        if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
    }
    return hash;
}

// ── Search keyword generation ─────────────────────────────────────────────────
// Category synonym table. Extend this to add new categories — existing artisans
// will pick up new synonyms on their next profile update (upsert() regenerates).
// To add a brand-new category: add the key + synonym array below.
const CATEGORY_SYNONYMS = {
    'plumbing':   ['plumber', 'plumbers', 'pipe', 'pipes', 'leak', 'leaking', 'drainage', 'drain', 'tap', 'toilet', 'sink', 'water'],
    'electrical': ['electrician', 'electricians', 'wiring', 'wire', 'power', 'socket', 'switch', 'fan', 'light', 'circuit', 'fuse'],
    'carpentry':  ['carpenter', 'carpenters', 'wood', 'door', 'doors', 'furniture', 'cabinet', 'shelves', 'joinery', 'shelf'],
    'painting':   ['painter', 'painters', 'paint', 'wall', 'walls', 'coat', 'interior', 'exterior', 'colour', 'color', 'gloss'],
    'cooling':    ['ac', 'air conditioner', 'air conditioning', 'hvac', 'aircon', 'refrigeration', 'fridge', 'freezer', 'cold'],
    'welding':    ['welder', 'welders', 'weld', 'metal', 'steel', 'fabrication', 'gate', 'fence', 'iron', 'grill'],
    'tiling':     ['tiler', 'tilers', 'tile', 'tiles', 'floor', 'flooring', 'ceramic', 'mosaic', 'grout'],
    'cleaning':   ['cleaner', 'cleaners', 'clean', 'mop', 'sweep', 'laundry', 'wash', 'housekeeping', 'domestic', 'dusting'],
    'masonry':    ['mason', 'masons', 'brick', 'bricks', 'concrete', 'block', 'blocks', 'foundation', 'screed', 'plastering'],
    'roofing':    ['roofer', 'roofers', 'roof', 'gutter', 'gutters', 'waterproofing', 'flashing'],
};

/**
 * Build the searchKeywords array from an artisan's profile data.
 * Called automatically by upsert() — every registration is immediately searchable.
 * Produces: name tokens, specialty, category, category synonyms, common phrases,
 * and any explicit commonSearchPhrases set by the artisan or admin.
 */
function _buildSearchKeywords(data) {
    const terms = new Set();

    const name      = (data.name      || '').toLowerCase().trim();
    const specialty = (data.specialty || '').toLowerCase().trim();
    const category  = (data.category  || '').toLowerCase().trim();

    if (name) {
        terms.add(name);
        name.split(/\s+/).filter(Boolean).forEach(w => terms.add(w));
    }
    if (specialty) terms.add(specialty);
    if (category)  terms.add(category);

    // Expand with category-specific synonyms
    const synonyms = CATEGORY_SYNONYMS[category] || CATEGORY_SYNONYMS[specialty] || [];
    synonyms.forEach(s => terms.add(s));

    // Common natural-language multi-word phrases
    const primary = specialty || category;
    if (primary) {
        terms.add(`emergency ${primary}`);
        terms.add(`fix ${primary}`);
        terms.add(`repair ${primary}`);
    }

    // Admin / artisan-supplied extra phrases
    (data.commonSearchPhrases || []).forEach(p => {
        if (p) terms.add(String(p).toLowerCase().trim());
    });

    return [...terms].filter(Boolean);
}

export function createArtisanRepository({
    databaseService,
    collectionName = DEFAULT_COLLECTION
}) {
    if (!databaseService) {
        throw new Error("ArtisanRepository requires a DatabaseService.");
    }

    return {
        collectionName,

        // ── Read ─────────────────────────────────────────────────────────────

        async getById(artisanId) {
            return databaseService.getDocument(collectionName, artisanId);
        },

        /**
         * Firestore-backed keyword search. Returns APPROVED artisans only.
         *
         * Multi-word queries are split and searched with array-contains-any so
         * "emergency plumber" matches artisans that have either "emergency plumber",
         * "emergency", or "plumber" in their searchKeywords array.
         *
         * Results are sorted by rating desc client-side — Firestore prohibits
         * orderBy alongside array-contains / array-contains-any.
         *
         * Partial-match limitation: Firestore array-contains is exact-match only.
         * "plumb" will NOT match "plumber". The _buildSearchKeywords() generator
         * pre-indexes common synonyms so this rarely matters in practice.
         * For true fuzzy/prefix search, migrate to Algolia or Typesense.
         *
         * Required Firestore composite index:
         *   artisans: searchKeywords (ARRAY_CONTAINS) + verificationStatus (ASC)
         */
        async searchByKeyword(keyword, { limitCount = 20 } = {}) {
            const clean = (keyword || "").trim().toLowerCase();
            if (!clean) return [];

            // Build token list: full phrase + individual words (most specific first).
            // array-contains-any is limited to 10 values by Firestore.
            const words  = clean.split(/\s+/).filter(Boolean);
            const terms  = words.length > 1 ? [clean, ...words] : [clean];
            const unique = [...new Set(terms)].slice(0, 10);

            const op    = unique.length > 1 ? 'array-contains-any' : 'array-contains';
            const value = unique.length > 1 ? unique : unique[0];

            const results = await databaseService.queryWithOptions(
                collectionName,
                [
                    { field: 'searchKeywords',     op,       value },
                    { field: 'verificationStatus', op: '==', value: 'approved' }
                ],
                { limit: limitCount }
            );

            // Sort by rating descending (cannot use Firestore orderBy with array operators)
            return results.sort((a, b) => (b.data.rating || 0) - (a.data.rating || 0));
        },

        /**
         * All APPROVED artisans in a given category, sorted by rating descending.
         * Requires composite index: category ASC + verificationStatus ASC + rating DESC.
         */
        async findByCategory(category, limitCount = 20) {
            return databaseService.queryWithOptions(
                collectionName,
                [
                    { field: 'category',           op: '==', value: category    },
                    { field: 'verificationStatus', op: '==', value: 'approved'  },
                ],
                { orderBy: { field: 'rating', direction: 'desc' }, limit: limitCount }
            );
        },

        /**
         * Top-rated APPROVED available artisans — used for the "Nearby Professionals" list.
         * Requires composite index: isAvailable ASC + verificationStatus ASC + rating DESC.
         */
        async getTopRated(limitCount = 10) {
            return databaseService.queryWithOptions(
                collectionName,
                [
                    { field: 'isAvailable',        op: '==', value: true       },
                    { field: 'verificationStatus', op: '==', value: 'approved' },
                ],
                { orderBy: { field: 'rating', direction: 'desc' }, limit: limitCount }
            );
        },

        // ── Write ─────────────────────────────────────────────────────────────

        /**
         * Create or merge an artisan document.
         * Call this from the artisan sign-up / profile-edit flow.
         */
        async upsert(artisanId, data) {
            const existing = await this.getById(artisanId);

            // Auto-generate searchKeywords from profile fields so every artisan
            // is immediately discoverable in search without manual keyword entry.
            // Caller-supplied keywords are merged with the auto-generated set.
            const autoKeywords    = _buildSearchKeywords(data);
            const callerKeywords  = Array.isArray(data.searchKeywords) ? data.searchKeywords : [];
            const mergedKeywords  = [...new Set([...autoKeywords, ...callerKeywords])];

            const hasCoords = typeof data.lat === 'number' && typeof data.lng === 'number';

            const payload  = {
                name:                data.name                ?? "",
                specialty:           data.specialty           ?? "",
                category:            data.category            ?? "",
                location:            data.location            ?? "",
                profileImage:        data.profileImage        ?? null,
                bio:                 data.bio                 ?? "",
                phone:               data.phone               ?? "",
                rating:              data.rating              ?? 0,
                reviewCount:         data.reviewCount         ?? 0,
                jobsCompleted:       data.jobsCompleted       ?? 0,
                isAvailable:         data.isAvailable         ?? true,
                commonSearchPhrases: data.commonSearchPhrases ?? [],
                searchKeywords:      mergedKeywords,
                updatedAt:           now()
            };

            if (hasCoords) {
                payload.lat     = data.lat;
                payload.lng     = data.lng;
                payload.geohash = _geohashForPoint(data.lat, data.lng);
            }

            if (!existing?.exists) {
                payload.createdAt = now();
            }

            await databaseService.setDocument(collectionName, artisanId, payload, { merge: true });
        },

        /**
         * @deprecated — rating updates are now handled server-side by the
         * `onBookingReviewed` Cloud Function (functions/reviews.js) using a
         * Firestore transaction. That function fires automatically when a customer
         * writes their `rating` field to a completed booking document.
         *
         * This method is a no-op. Remove any calls from client code.
         *
         * @param {string} _artisanId
         * @param {number} _newRatingScore
         */
        async applyNewReview(_artisanId, _newRatingScore) {
            console.warn(
                '[artisanRepository] applyNewReview() is deprecated and does nothing. ' +
                'The onBookingReviewed Cloud Function (functions/reviews.js) handles ' +
                'artisan rating updates atomically via Firestore transaction. ' +
                'Remove calls to this method from client code.'
            );
        },

        /**
         * Toggle the artisan's online/offline availability.
         */
        async setAvailability(artisanId, isAvailable) {
            await databaseService.updateDocument(collectionName, artisanId, {
                isAvailable: Boolean(isAvailable),
                updatedAt:   now()
            });
        },

        /**
         * Update the artisan's online presence and GPS coordinates.
         * Enforces database portability by wrapping Firestore updates.
         */
        async updatePresenceAndLocation(artisanId, {
            isOnline,
            isAvailable,
            latitude,
            longitude,
            accuracy,
            source
        }) {
            const nowISO = now();
            const payload = {
                isOnline: Boolean(isOnline),
                isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : Boolean(isOnline),
                lastActive: nowISO,
                updatedAt: nowISO,
                presenceUpdatedAt: nowISO,
                lastHeartbeat: nowISO
            };

            // Only update location fields if valid coordinate data is provided
            if (typeof latitude === 'number' && typeof longitude === 'number') {
                payload.latitude           = latitude;
                payload.longitude          = longitude;
                payload.lat                = latitude;
                payload.lng                = longitude;
                payload.currentLat         = latitude;
                payload.currentLng         = longitude;
                payload.geohash            = _geohashForPoint(latitude, longitude);
                payload.locationAccuracy   = typeof accuracy === 'number' ? accuracy : null;
                payload.locationSource     = source || 'browser';
                payload.lastLocationUpdate = nowISO;
            }

            await databaseService.updateDocument(collectionName, artisanId, payload);
        },

        /**
         * @deprecated — jobsCompleted is now atomically incremented by the
         * `onBookingStatusChanged` Cloud Function (functions/bookings.js) using
         * FieldValue.increment(1) when a booking transitions to 'completed'.
         * Do NOT call this from client code — the counter will double-count.
         *
         * Kept here so existing call-sites get a clear deprecation message at
         * runtime instead of a silent crash.
         */
        async incrementJobsCompleted(artisanId) {
            console.warn(
                '[artisanRepository] incrementJobsCompleted() is deprecated. ' +
                'jobsCompleted is now incremented by the onBookingStatusChanged Cloud Function. ' +
                'Remove calls to this method from client code.'
            );
            // No-op — Cloud Function handles this atomically.
        }
    };
}
