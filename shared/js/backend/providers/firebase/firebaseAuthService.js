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
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
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

    waitForUser() {
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
    }
  };
}

