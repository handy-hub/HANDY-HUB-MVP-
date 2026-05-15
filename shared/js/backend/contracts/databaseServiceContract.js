const REQUIRED_DATABASE_METHODS = [
  "getDocument",
  "setDocument",
  "queryByField",
  "getMetadata"
];

/**
 * Validates the DatabaseService contract used by repositories.
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

