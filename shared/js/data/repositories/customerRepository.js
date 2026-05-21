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
         *
         * CREATE  — sends every field required by isValidCustomer() in Firestore rules
         *           (id, userType, status, bookings, spent, email, name, …).
         * UPDATE  — sends only fields in isSafeCustomerProfileUpdate() allowlist;
         *           email is intentionally excluded (not in the allowlist).
         */
        async upsert(customerId, data, options = { merge: true }) {
            const existing = await this.getById(customerId);

            if (!existing?.exists) {
                // Full create payload — must satisfy isValidCustomer() rule
                const payload = {
                    id:                      customerId,
                    userType:                "customer",
                    status:                  "active",
                    email:                   (data.email || "").trim().toLowerCase(),
                    name:                    (data.name  || "Customer").trim(),
                    phone:                   (data.phone || "").trim(),
                    location:                (data.location || "Not specified").trim(),
                    profileImage:            data.profileImage ?? null,
                    walletBalance:           typeof data.walletBalance === "number" ? data.walletBalance : 0,
                    bookings:                typeof data.bookings === "number" ? data.bookings : 0,
                    spent:                   typeof data.spent    === "number" ? data.spent    : 0,
                    recentSearches:          Array.isArray(data.recentSearches) ? data.recentSearches : [],
                    recentSearchesUpdatedAt: data.recentSearchesUpdatedAt ?? null,
                    createdAt:               now(),
                    updatedAt:               now()
                };
                await databaseService.setDocument(collectionName, customerId, payload, { merge: false });
            } else {
                // Partial update — only fields allowed by isSafeCustomerProfileUpdate()
                // email is deliberately excluded (not in the Firestore allowlist for updates)
                const payload = { updatedAt: now() };
                if (data.name         !== undefined) payload.name         = data.name;
                if (data.phone        !== undefined) payload.phone        = data.phone;
                if (data.location     !== undefined) payload.location     = data.location;
                if (data.bio          !== undefined) payload.bio          = data.bio;
                if (data.profileImage !== undefined) payload.profileImage = data.profileImage;
                if (data.walletBalance !== undefined) payload.walletBalance = data.walletBalance;
                if (data.recentSearches          !== undefined) payload.recentSearches          = data.recentSearches;
                if (data.recentSearchesUpdatedAt !== undefined) payload.recentSearchesUpdatedAt = data.recentSearchesUpdatedAt;
                if (data.notificationPreferences !== undefined) payload.notificationPreferences = data.notificationPreferences;
                if (data.privacySettings         !== undefined) payload.privacySettings         = data.privacySettings;
                if (data.appPreferences          !== undefined) payload.appPreferences          = data.appPreferences;
                await databaseService.setDocument(collectionName, customerId, payload, { merge: true });
            }
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
