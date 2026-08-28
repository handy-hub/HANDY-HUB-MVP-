export function createAuthRepository({ authService }) {
  if (!authService) {
    throw new Error("AuthRepository requires an AuthService.");
  }

  return {
    signInWithEmail(email, password) {
      return authService.signInWithEmail(email, password);
    },

    signUpWithEmail(email, password) {
      return authService.signUpWithEmail(email, password);
    },

    signInWithSocial(providerName, options) {
      return authService.signInWithSocial(providerName, options);
    },

    getRedirectResult() {
      return authService.getRedirectResult();
    },

    async signOut() {
      // Clear cached view data BEFORE tearing down the session. Cache entries
      // are uid-scoped so another account can never read them, but on a shared
      // device the departing user's name, bookings and balances should not be
      // left sitting in localStorage. Never let a cache failure block sign-out.
      try {
        const { clearAllCaches } = await import('../../services/persistentCache.js');
        clearAllCaches();
      } catch (_) { /* cache unavailable — signing out still matters more */ }

      return authService.signOut();
    },

    deleteCurrentUser() {
      return authService.deleteCurrentUser();
    },

    getCurrentUser() {
      return authService.getCurrentUser();
    },

    extractSignInMetadata(authResult) {
      return authService.extractSignInMetadata(authResult);
    }
  };
}

