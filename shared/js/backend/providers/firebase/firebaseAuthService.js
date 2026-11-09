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
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updatePassword
} from "../../../../vendor/firebase/firebase-auth.js";
import { firebaseAuth } from "./firebaseConfig.js";
import { isNativeShell } from "../../../config/runtimeEnv.js";

/**
 * Google sign-in inside the packaged Android app.
 *
 * The web flow cannot work there: signInWithPopup has no window to open in the
 * WebView, and the signInWithRedirect fallback sends the WebView to
 * firebaseapp.com, which Capacitor opens in the EXTERNAL browser — the customer
 * picks their Google account in Chrome and the app never hears back (and Google
 * refuses OAuth inside embedded WebViews anyway). So in the native shell the
 * account is chosen by the native FxGoogleSignIn plugin
 * (android/app/src/main/java/com/handyhub/customer/GoogleSignInPlugin.java) and
 * only its Google ID token comes back here, where the same Firebase JS SDK signs
 * in with it — one Firebase user and session, exactly as on the web.
 *
 * Errors carry auth/* codes the pages already explain; nothing falls back to
 * the popup/redirect, which in a WebView only strands the customer in Chrome.
 */
function nativeGooglePlugin() {
  try {
    const cap = typeof window !== "undefined" ? window.Capacitor : null;
    return (cap && cap.Plugins && cap.Plugins.FxGoogleSignIn) || null;
  } catch (_) {
    return null;
  }
}

const NATIVE_GOOGLE_ERRORS = {
  cancelled:      "auth/popup-closed-by-user",
  no_account:     "auth/no-google-account",
  not_configured: "auth/native-google-not-configured",
};

async function signInWithGoogleNatively(authInstance) {
  const plugin = nativeGooglePlugin();
  if (!plugin) {
    // An installed app built before native Google sign-in existed.
    throw Object.assign(new Error("Google sign-in needs the latest version of the app."), {
      code: "auth/native-google-unavailable",
    });
  }
  let native;
  try {
    native = await plugin.signIn();
  } catch (err) {
    const code = NATIVE_GOOGLE_ERRORS[err && err.code] || "auth/native-google-failed";
    throw Object.assign(new Error((err && err.message) || "Google sign-in failed."), { code, nativeCode: err && err.code });
  }
  if (!native || !native.idToken) {
    throw Object.assign(new Error("Google did not return an account."), { code: "auth/native-google-failed" });
  }
  return signInWithCredential(authInstance, GoogleAuthProvider.credential(native.idToken));
}

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
      // Inside the native app Google goes through the native account picker;
      // popup and redirect cannot complete in a WebView (see above).
      if (providerName === "Google" && isNativeShell()) {
        return signInWithGoogleNatively(authInstance);
      }

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

    /**
     * Email a password-reset link. Firebase answers the same way whether or not
     * the address has an account (email-enumeration protection), and callers
     * must say the same thing in both cases (artisan login, AUTH-002).
     */
    async sendPasswordResetEmail(email) {
      await sendPasswordResetEmail(authInstance, email);
    },

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

