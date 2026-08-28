import { createFirebaseBackendProvider } from "../backend/providers/firebase/index.js";

const BACKEND_BUILDERS = {
  firebase: createFirebaseBackendProvider
};

/**
 * Backend provider selector.
 * Swap this mapping to migrate to another backend without touching UI/domain/repositories.
 */
export function createBackendProvider(providerName = "firebase") {
  const builder = BACKEND_BUILDERS[providerName];

  if (!builder) {
    throw new Error(`Unknown backend provider: ${providerName}`);
  }

  return builder();
}

