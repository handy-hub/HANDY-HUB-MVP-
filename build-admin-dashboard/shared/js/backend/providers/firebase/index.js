import { assertAuthService } from "../../contracts/authServiceContract.js";
import { assertDatabaseService } from "../../contracts/databaseServiceContract.js";
import { assertNotificationService } from "../../contracts/notificationServiceContract.js";
import { assertStorageService } from "../../contracts/storageServiceContract.js";
import { createFirebaseAuthService } from "./firebaseAuthService.js";
import { createFirebaseDatabaseService } from "./firebaseDatabaseService.js";
import { createFirebaseNotificationService } from "./firebaseNotificationService.js";
import { createFirebaseStorageService } from "./firebaseStorageService.js";

export function createFirebaseBackendProvider() {
  const services = {
    authService: createFirebaseAuthService(),
    databaseService: createFirebaseDatabaseService(),
    storageService: createFirebaseStorageService(),
    notificationService: createFirebaseNotificationService()
  };

  assertAuthService(services.authService);
  assertDatabaseService(services.databaseService);
  assertStorageService(services.storageService);
  assertNotificationService(services.notificationService);

  return services;
}

