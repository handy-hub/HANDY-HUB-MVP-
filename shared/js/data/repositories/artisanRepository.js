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
         * Full-text keyword search using Firestore array-contains.
         * The searchKeywords field is maintained by searchKeywordSeeder.js.
         */
        async searchByKeyword(keyword) {
            const clean = (keyword || "").trim().toLowerCase();
            if (!clean) return [];
            return databaseService.queryByField(
                collectionName, "searchKeywords", "array-contains", clean
            );
        },

        /**
         * All artisans in a given category, sorted by rating descending.
         * Requires composite index: category ASC + rating DESC.
         */
        async findByCategory(category, limitCount = 20) {
            return databaseService.queryWithOptions(
                collectionName,
                [{ field: "category", op: "==", value: category }],
                { orderBy: { field: "rating", direction: "desc" }, limit: limitCount }
            );
        },

        /**
         * Top-rated available artisans — used for the "Nearby Professionals" list.
         * Requires composite index: isAvailable ASC + rating DESC.
         */
        async getTopRated(limitCount = 10) {
            return databaseService.queryWithOptions(
                collectionName,
                [{ field: "isAvailable", op: "==", value: true }],
                { orderBy: { field: "rating", direction: "desc" }, limit: limitCount }
            );
        },

        // ── Write ─────────────────────────────────────────────────────────────

        /**
         * Create or merge an artisan document.
         * Call this from the artisan sign-up / profile-edit flow.
         */
        async upsert(artisanId, data) {
            const existing = await this.getById(artisanId);
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
                searchKeywords:      data.searchKeywords      ?? [],
                updatedAt:           now()
            };

            if (!existing?.exists) {
                payload.createdAt = now();
            }

            await databaseService.setDocument(collectionName, artisanId, payload, { merge: true });
        },

        /**
         * Recompute the artisan's average rating after a new review is submitted.
         *
         * KNOWN TOCTOU: This reads rating/reviewCount then writes. Two concurrent
         * reviews could produce a wrong average. The safe fix is a Cloud Function
         * triggered on the `reviews` collection that uses a Firestore transaction.
         * Acceptable risk at current scale — move to server-side when review volume
         * justifies it.
         *
         * @param {string} artisanId
         * @param {number} newRatingScore  The score from the new review (1–5)
         */
        async applyNewReview(artisanId, newRatingScore) {
            const score = Math.max(1, Math.min(5, Number(newRatingScore)));
            if (isNaN(score)) throw new Error("newRatingScore must be a number between 1 and 5.");

            const record = await this.getById(artisanId);
            if (!record?.exists) throw new Error("Artisan not found.");

            const { rating = 0, reviewCount = 0 } = record.data;
            const nextCount  = reviewCount + 1;
            const nextRating = ((rating * reviewCount) + score) / nextCount;

            await databaseService.updateDocument(collectionName, artisanId, {
                rating:      Math.round(nextRating * 10) / 10,
                reviewCount: nextCount,
                updatedAt:   now()
            });
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
                payload.lat                = latitude;          // backend dispatch compatibility
                payload.lng                = longitude;          // backend dispatch compatibility
                payload.currentLat         = latitude;          // tracking page compatibility
                payload.currentLng         = longitude;          // tracking page compatibility
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
