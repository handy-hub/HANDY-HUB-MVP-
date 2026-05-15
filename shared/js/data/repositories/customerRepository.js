const DEFAULT_COLLECTION = "customers";

function normalizePhone(value) {
  return (value || "").replace(/[^\d+]/g, "").trim();
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
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

    async getById(customerId) {
      return databaseService.getDocument(collectionName, customerId);
    },

    async upsert(customerId, data, options = { merge: true }) {
      await databaseService.setDocument(collectionName, customerId, data, options);
    },

    async findByEmail(email) {
      const normalizedEmail = (email || "").trim().toLowerCase();
      if (!normalizedEmail) return null;

      const results = await databaseService.queryByField(
        collectionName,
        "email",
        "==",
        normalizedEmail
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
          collectionName,
          "phone",
          "==",
          candidate
        );

        if (results.length > 0) {
          return results[0];
        }
      }

      return null;
    }
  };
}

