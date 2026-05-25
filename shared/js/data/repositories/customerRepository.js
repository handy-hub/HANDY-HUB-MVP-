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
                    // Financial fields are always initialised to 0.
                    // Cloud Functions are the sole authority for all subsequent mutations.
                    // Never trust a caller-supplied walletBalance on creation.
                    walletBalance:           0,
                    escrowBalance:           0,
                    bookings:                0,
                    spent:                   0,
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
                // walletBalance intentionally excluded — Cloud Functions own all balance mutations.
                // escrowBalance intentionally excluded — Cloud Functions own all balance mutations.
                // spent intentionally excluded — Cloud Functions update this on booking completion.
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
         * ⛔  REMOVED — adjustWalletBalance() was removed.
         *
         * Wallet balance mutations are EXCLUSIVELY a Cloud Function responsibility.
         * The Firestore security rules block clients from writing walletBalance.
         * Any attempt to call this from the browser would silently fail against rules.
         *
         * Server-side wallet credits:  functions/financial/wallets.js  creditWalletFromCharge()
         * Server-side debits:          functions/financial/transfers.js executeCustomerWithdrawal()
         * Server-side escrow:          functions/financial/escrow.js    holdFundsForBooking()
         *
         * This comment intentionally replaces the method body to prevent future
         * developers from re-introducing frontend balance mutations.
         */
    };
}
