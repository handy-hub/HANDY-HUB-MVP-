import { createBackendProvider }      from "./backendProviderFactory.js";
import { createAuthRepository }       from "../data/repositories/authRepository.js";
import { createCustomerRepository }   from "../data/repositories/customerRepository.js";
import { createArtisanRepository }    from "../data/repositories/artisanRepository.js";
import { createBookingRepository }    from "../data/repositories/bookingRepository.js";
import { createChatRepository }       from "../data/repositories/chatRepository.js";
import { createCustomerAuthService }  from "../domain/services/customerAuthService.js";
import { createSessionService }       from "../domain/services/sessionService.js";

let containerInstance = null;
let activeBackend     = null;

function buildContainer(backendName) {
    const backendServices = createBackendProvider(backendName);
    const db = backendServices.databaseService;

    // ── Data layer: repositories depend only on backend contracts ───────────
    const repositories = {
        authRepository:     createAuthRepository({ authService: backendServices.authService }),
        customerRepository: createCustomerRepository({ databaseService: db }),
        artisanRepository:  createArtisanRepository({ databaseService: db }),
        bookingRepository:  createBookingRepository({ databaseService: db }),
        chatRepository:     createChatRepository({ databaseService: db })
    };

    // ── Domain layer: business rules depend only on repositories ────────────
    const services = {
        customerAuthService: createCustomerAuthService({
            authRepository:     repositories.authRepository,
            customerRepository: repositories.customerRepository
        }),
        sessionService: createSessionService({
            authRepository: repositories.authRepository
        }),
        notificationService: backendServices.notificationService,

        // Raw backend services exposed for use-cases that need them directly
        // (e.g. auth state subscription, file upload, single-doc listeners).
        // Swap the backend provider in backendProviderFactory.js to migrate.
        authService:     backendServices.authService,
        databaseService: backendServices.databaseService,
        storageService:  backendServices.storageService
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
 * Swap the backend provider mapping in backendProviderFactory.js to migrate
 * away from Firebase without touching UI, domain, or repository code.
 */
export function getAppContainer(options = {}) {
    const requestedBackend = options.backend || "firebase";

    if (!containerInstance || activeBackend !== requestedBackend) {
        containerInstance = buildContainer(requestedBackend);
        activeBackend     = requestedBackend;
    }

    return containerInstance;
}
