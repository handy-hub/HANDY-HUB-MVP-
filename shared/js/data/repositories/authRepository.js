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

    signOut() {
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

