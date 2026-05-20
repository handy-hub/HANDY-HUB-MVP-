const REQUIRED_DATABASE_METHODS = [
    // ── Original ──────────────────────────────────────────────────────────
    "getDocument",
    "setDocument",
    "queryByField",
    "getMetadata",

    // ── Document CRUD ─────────────────────────────────────────────────────
    "addDocument",
    "updateDocument",
    "deleteDocument",

    // ── Flexible queries ──────────────────────────────────────────────────
    "queryWithOptions",
    "subscribeToCollection",

    // ── Sub-collection CRUD ───────────────────────────────────────────────
    "addSubDocument",
    "updateSubDocument",
    "querySubCollection",
    "subscribeToSubCollection"
];

/**
 * Validates the DatabaseService contract used by repositories.
 * Any backend provider must implement all methods below.
 */
export function assertDatabaseService(service) {
    if (!service || typeof service !== "object") {
        throw new Error("DatabaseService must be an object.");
    }

    REQUIRED_DATABASE_METHODS.forEach((methodName) => {
        if (typeof service[methodName] !== "function") {
            throw new Error(`DatabaseService is missing required method: ${methodName}`);
        }
    });
}
