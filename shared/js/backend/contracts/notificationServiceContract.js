const REQUIRED_NOTIFICATION_METHODS = [
  "send"
];

/**
 * Validates the NotificationService contract.
 */
export function assertNotificationService(service) {
  if (!service || typeof service !== "object") {
    throw new Error("NotificationService must be an object.");
  }

  REQUIRED_NOTIFICATION_METHODS.forEach((methodName) => {
    if (typeof service[methodName] !== "function") {
      throw new Error(`NotificationService is missing required method: ${methodName}`);
    }
  });
}

