import { createBackendProvider } from "./backendProviderFactory.js";
import { createAuthRepository } from "../data/repositories/authRepository.js";
import { createCustomerRepository } from "../data/repositories/customerRepository.js";
import { createCustomerAuthService } from "../domain/services/customerAuthService.js";
import { createSessionService } from "../domain/services/sessionService.js";

let containerInstance = null;
let activeBackend = null;

function buildContainer(backendName) {
  const backendServices = createBackendProvider(backendName);

  // Data layer: repositories depend only on backend contracts, not Firebase SDK.
  const repositories = {
    authRepository: createAuthRepository({ authService: backendServices.authService }),
    customerRepository: createCustomerRepository({ databaseService: backendServices.databaseService })
  };

  // Domain layer: business rules depend on repositories, not on provider SDKs.
  const services = {
    customerAuthService: createCustomerAuthService({
      authRepository: repositories.authRepository,
      customerRepository: repositories.customerRepository
    }),
    sessionService: createSessionService({
      authRepository: repositories.authRepository
    }),
    notificationService: backendServices.notificationService
  };

  return {
    backend: backendName,
    backendServices,
    repositories,
    services
  };
}

/**
 * Shared DI container.
 * If Firebase is replaced, only backend provider files + factory mapping should change.
 */
export function getAppContainer(options = {}) {
  const requestedBackend = options.backend || "firebase";

  if (!containerInstance || activeBackend !== requestedBackend) {
    containerInstance = buildContainer(requestedBackend);
    activeBackend = requestedBackend;
  }

  return containerInstance;
}

