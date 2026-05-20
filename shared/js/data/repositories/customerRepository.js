/**
 * customerRepository.js
 *
 * Collection: "customers"
 * Document ID: Firebase Auth UID
 *
 * Schema
 * ──────
 * email                   string   (indexed)
 * phone                   string   (indexed)
 * name                    string
 * profileImage            string | null   (Storage download URL)
 * walletBalance           number          (GHC)
 * recentSearches          string[]
 * recentSearchesUpdatedAt string          (ISO timestamp)
 * createdAt               string          (ISO timestamp, set on first upsert)
 * updatedAt               string          (ISO timestamp, updated every write)
 */

const DEFAULT_COLLECTION = "customers";

function normalizePhone(value) {
    return (value || "").replace(/[^\d+]/g, "").trim();
}

function uniqueValues(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function now() {
    return new Date().toISOString();
}

export function createCustomerRepository({
    databaseService,
    collectionName = DEFAULT_COLLECTION
}) {
    if (!databaseService) {
        throw new Error("CustomerRepository requires a DatabaseService.");
    }

    return {
        collectionName,

        // ── Read ─────────────────────────────────────────────────────────────

        async getById(customerId) {
            return databaseService.getDocument(collectionName, customerId);
        },

        async findByEmail(email) {
            const normalizedEmail = (email || "").trim().toLowerCase();
            if (!normalizedEmail) return null;

            const results = await databaseService.queryByField(
                collectionName, "email", "==", normalizedEmail
            );
            return results[0] || null;
        },

        async findByPhone(phoneInput) {
            const candidates = uniqueValues([
                (phoneInput || "").trim(),
                normalizePhone(phoneInput)
            ]);

            for (const candidate of candidates) {
                const results = await databaseService.queryByField(
                    collectionName, "phone", "==", candidate
                );
                if (results.length > 0) return results[0];
            }
            return null;
        },

        // ── Write ─────────────────────────────────────────────────────────────

        /**
         * Create or merge a customer document.
         * On first write, sets createdAt; every write refreshes updatedAt.
         */
        async upsert(customerId, data, options = { merge: true }) {
            const existing = await this.getById(customerId);
            const payload  = {
                email:                   (data.email  || "").trim().toLowerCase() || undefined,
                phone:                   data.phone   ?? undefined,
                name:                    data.name    ?? undefined,
                profileImage:            data.profileImage    ?? undefined,
                walletBalance:           data.walletBalance   ?? undefined,
                recentSearches:          data.recentSearches  ?? undefined,
                recentSearchesUpdatedAt: data.recentSearchesUpdatedAt ?? undefined,
                updatedAt:               now()
            };

            // Strip undefined keys so merge doesn't overwrite existing values
            Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

            if (!existing?.exists) {
                payload.createdAt = now();
                if (payload.walletBalance === undefined) payload.walletBalance = 0;
            }

            await databaseService.setDocument(collectionName, customerId, payload, options);
        },

        /**
         * Partial profile update — only name and/or profileImage.
         */
        async updateProfile(customerId, { name, profileImage }) {
            const patch = { updatedAt: now() };
            if (name         !== undefined) patch.name         = name;
            if (profileImage !== undefined) patch.profileImage = profileImage;
            await databaseService.updateDocument(collectionName, customerId, patch);
        },

        /**
         * Credit or debit the wallet balance.
         * Pass a positive amount to credit, negative to debit.
         * Throws if the resulting balance would go below zero.
         */
        async adjustWalletBalance(customerId, amount) {
            const record = await this.getById(customerId);
            if (!record?.exists) throw new Error("Customer not found.");

            const current = record.data.walletBalance ?? 0;
            const next    = current + amount;
            if (next < 0) throw new Error("Insufficient wallet balance.");

            await databaseService.updateDocument(collectionName, customerId, {
                walletBalance: next,
                updatedAt:     now()
            });

            return next;
        }
    };
}
