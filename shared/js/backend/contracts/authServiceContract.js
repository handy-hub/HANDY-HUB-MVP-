const REQUIRED_AUTH_METHODS = [
  "signInWithEmail",
  "signUpWithEmail",
  "signInWithSocial",
  "getRedirectResult",
  "signOut",
  "deleteCurrentUser",
  "getCurrentUser",
  "extractSignInMetadata",
  "subscribeToAuthState",
  "waitForUser",
  "reauthenticateWithPassword",
  "changePassword",
  "deleteAccount"
];

/**
 * Validates the AuthService contract.
 * The rest of the app can stay backend-agnostic as long as this contract is honored.
 */
export function assertAuthService(service) {
  if (!service || typeof service !== "object") {
    throw new Error("AuthService must be an object.");
  }

  REQUIRED_AUTH_METHODS.forEach((methodName) => {
    if (typeof service[methodName] !== "function") {
      throw new Error(`AuthService is missing required method: ${methodName}`);
    }
  });
}

