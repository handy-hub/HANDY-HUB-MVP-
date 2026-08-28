const REQUIRED_STORAGE_METHODS = [
  "uploadFile",
  "getDownloadUrl"
];

/**
 * Validates the StorageService contract.
 * This keeps file handling swappable across providers.
 */
export function assertStorageService(service) {
  if (!service || typeof service !== "object") {
    throw new Error("StorageService must be an object.");
  }

  REQUIRED_STORAGE_METHODS.forEach((methodName) => {
    if (typeof service[methodName] !== "function") {
      throw new Error(`StorageService is missing required method: ${methodName}`);
    }
  });
}

