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
         * @param {string} artisanId
         * @param {number} newRatingScore  The score from the new review (1–5)
         */
        async applyNewReview(artisanId, newRatingScore) {
            const record = await this.getById(artisanId);
            if (!record?.exists) throw new Error("Artisan not found.");

            const { rating = 0, reviewCount = 0 } = record.data;
            const nextCount  = reviewCount + 1;
            const nextRating = ((rating * reviewCount) + newRatingScore) / nextCount;

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
         * Increment jobsCompleted after a booking is marked complete.
         */
        async incrementJobsCompleted(artisanId) {
            const record = await this.getById(artisanId);
            if (!record?.exists) throw new Error("Artisan not found.");

            await databaseService.updateDocument(collectionName, artisanId, {
                jobsCompleted: (record.data.jobsCompleted ?? 0) + 1,
                updatedAt:     now()
            });
        }
    };
}
