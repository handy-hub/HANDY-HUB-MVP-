import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  FacebookAuthProvider,
  getAdditionalUserInfo,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  OAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updatePassword
} from "../../../../vendor/firebase/firebase-auth.js";
import { firebaseAuth } from "./firebaseConfig.js";

function buildSocialProvider(providerName) {
  if (providerName === "Google") {
    const provider = new GoogleAuthProvider();
    provider.addScope("email");
    provider.addScope("profile");
    return provider;
  }

  if (providerName === "Facebook") {
    const provider = new FacebookAuthProvider();
    provider.addScope("email");
    return provider;
  }

  if (providerName === "Apple") {
    const provider = new OAuthProvider("apple.com");
    provider.addScope("email");
    provider.addScope("name");
    return provider;
  }

  throw Object.assign(
    new Error(`Unsupported social provider: ${providerName}`),
    { code: "auth/unsupported-provider" }
  );
}

function providerNameFromId(providerId) {
  if (providerId === "google.com") return "Google";
  if (providerId === "facebook.com") return "Facebook";
  if (providerId === "apple.com") return "Apple";
  return "Social";
}

export function createFirebaseAuthService(authInstance = firebaseAuth) {
  return {
    async signInWithEmail(email, password) {
      return signInWithEmailAndPassword(authInstance, email, password);
    },

    async signUpWithEmail(email, password) {
      return createUserWithEmailAndPassword(authInstance, email, password);
    },

    async signInWithSocial(providerName, options = {}) {
      const mode = options.mode || "popup";
      const provider = buildSocialProvider(providerName);

      if (mode === "redirect") {
        await signInWithRedirect(authInstance, provider);
        return null;
      }

      return signInWithPopup(authInstance, provider);
    },

    async getRedirectResult() {
      return getRedirectResult(authInstance);
    },

    async signOut() {
      return signOut(authInstance);
    },

    async deleteCurrentUser() {
      if (!authInstance.currentUser) return;
      await deleteUser(authInstance.currentUser);
    },

    getCurrentUser() {
      return authInstance.currentUser;
    },

    extractSignInMetadata(authResult) {
      const additionalInfo = authResult ? getAdditionalUserInfo(authResult) : null;
      const providerId = (additionalInfo && additionalInfo.providerId) || "";

      return {
        isNewUser: Boolean(additionalInfo && additionalInfo.isNewUser),
        providerId,
        providerName: providerNameFromId(providerId)
      };
    },

    subscribeToAuthState(callback) {
      return onAuthStateChanged(authInstance, callback);
    },

    /**
     * Resolve the INITIAL auth state, definitively.
     *
     * authStateReady() settles once the SDK has finished restoring from local
     * persistence. That restore does NOT require the network, so its resolution
     * is authoritative: currentUser is either a genuinely restored session or
     * genuinely null. Callers may therefore treat a null result as "signed out"
     * — and must never infer that from elapsed time instead.
     *
     * onAuthStateChanged is retained as a fallback for SDKs without
     * authStateReady; its first emission carries the same guarantee.
     */
    waitForUser() {
      if (typeof authInstance.authStateReady === 'function') {
        return authInstance.authStateReady().then(() => authInstance.currentUser || null);
      }
      return new Promise((resolve) => {
        const stop = onAuthStateChanged(authInstance, (user) => {
          stop();
          resolve(user);
        });
      });
    },

    async reauthenticateWithPassword(password) {
      const user = authInstance.currentUser;
      if (!user) throw Object.assign(new Error("No signed-in user"), { code: "auth/no-current-user" });
      const credential = EmailAuthProvider.credential(user.email, password);
      await reauthenticateWithCredential(user, credential);
    },

    // ── Step-up identity check (optional methods) ──
    // Destructive account actions are re-checked on the SERVER from the ID
    // token's auth_time (functions/accountLifecycle.js), so after proving who
    // they are the token is refreshed — otherwise the callable would still see
    // the old sign-in time.

    /** The sign-in methods on this account, e.g. ['password'] or ['google.com']. */
    signInProviders() {
      const user = authInstance.currentUser;
      return user ? user.providerData.map((p) => p.providerId) : [];
    },

    /** Re-authenticate with a password, or with Google when no password is given. */
    async reauthenticate(password) {
      const user = authInstance.currentUser;
      if (!user) throw Object.assign(new Error("No signed-in user"), { code: "auth/no-current-user" });
      if (password) {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      } else {
        await reauthenticateWithPopup(user, buildSocialProvider("Google"));
      }
      await user.getIdToken(true);
    },

    async changePassword(newPassword) {
      const user = authInstance.currentUser;
      if (!user) throw Object.assign(new Error("No signed-in user"), { code: "auth/no-current-user" });
      await updatePassword(user, newPassword);
    },

    async deleteAccount(password) {
      const user = authInstance.currentUser;
      if (!user) throw Object.assign(new Error("No signed-in user"), { code: "auth/no-current-user" });
      const credential = EmailAuthProvider.credential(user.email, password);
      await reauthenticateWithCredential(user, credential);
      await deleteUser(user);
    },

    // ── Email verification (optional methods — not in the required contract) ──
    // Firebase Auth's own verification link: it needs no sending domain of ours,
    // so it works while the Resend OTP path is switched off (artisan signup.html,
    // REQUIRE_EMAIL_OTP). Verified status reaches firestore.rules as
    // request.auth.token.email_verified once the ID token is refreshed.

    /** Email the signed-in user a verification link. */
    async sendEmailVerification(continueUrl = null) {
      const user = authInstance.currentUser;
      if (!user) throw Object.assign(new Error("No signed-in user"), { code: "auth/no-current-user" });
      await sendEmailVerification(user, continueUrl ? { url: continueUrl } : undefined);
    },

    /**
     * Re-read the user from Firebase Auth and refresh the ID token, so a link
     * clicked in another tab or app takes effect here — in the UI AND in the
     * token the rules see. Returns whether the email is now verified.
     */
    async refreshUser() {
      const user = authInstance.currentUser;
      if (!user) throw Object.assign(new Error("No signed-in user"), { code: "auth/no-current-user" });
      await reload(user);
      await user.getIdToken(true);
      return { emailVerified: !!authInstance.currentUser?.emailVerified };
    }
  };
}

