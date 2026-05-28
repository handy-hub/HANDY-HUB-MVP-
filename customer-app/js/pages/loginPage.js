import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import { showToast } from "../../../shared/js/components/toast.js";
import { consumeReturnUrl } from "../../../shared/js/utils/authGuard.js";

const DASHBOARD_REDIRECT_URL = "dashboard.html";
const LOGIN_LOADING_TEXT = "Logging in...";

const {
  services: { customerAuthService }
} = getAppContainer();

const loginForm = document.getElementById("login-form");
const identifierInput = document.getElementById("user-id");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("login-btn");

const googleLoginBtn = document.getElementById("google-login-btn");
const appleLoginBtn = document.getElementById("apple-login-btn");
const facebookLoginBtn = document.getElementById("facebook-login-btn");
const socialButtons = [googleLoginBtn, appleLoginBtn, facebookLoginBtn].filter(Boolean);

socialButtons.forEach((button) => {
  button.dataset.defaultHtml = button.innerHTML;
});

if (loginBtn) {
  loginBtn.dataset.defaultHtml = loginBtn.innerHTML;
}

function createButtonLoadingHtml(label) {
  return `${label}<span class="button-loader" aria-hidden="true"></span>`;
}

function setLoginLoading(isLoading) {
  if (!loginBtn) return;
  const defaultLoginButtonHtml = loginBtn.dataset.defaultHtml || loginBtn.innerHTML;

  loginBtn.disabled = isLoading;
  loginBtn.style.opacity = isLoading ? "0.7" : "1";
  loginBtn.style.cursor = isLoading ? "not-allowed" : "pointer";
  loginBtn.innerHTML = isLoading ? createButtonLoadingHtml(LOGIN_LOADING_TEXT) : defaultLoginButtonHtml;
}

function setSocialLoading(isLoading, activeButton = null, activeLabel = "Please wait...") {
  socialButtons.forEach((button) => {
    button.disabled = isLoading;
    button.style.opacity = isLoading ? "0.7" : "1";
    button.style.cursor = isLoading ? "not-allowed" : "pointer";
    if (!isLoading && button.dataset.defaultHtml) {
      button.innerHTML = button.dataset.defaultHtml;
    }
  });

  if (isLoading && activeButton) {
    activeButton.textContent = activeLabel;
  }
}

function loginErrorMessage(error) {
  switch (error.code) {
    case "auth/missing-identifier":
      return "Enter your email or phone number.";
    case "auth/invalid-phone-value":
      return "Enter a valid phone number.";
    case "auth/customer-not-found":
      return "No customer account found for that phone number.";
    case "auth/customer-email-missing":
      return "This phone number has no linked email. Please use email login.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "Phone lookup is not allowed right now. Please login with your email.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email/phone or password.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Please wait and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your internet connection and try again.";
    default:
      return "Login failed. Please try again.";
  }
}

function socialErrorMessage(error, providerName) {
  switch (error.code) {
    case "auth/operation-not-allowed":
      return `${providerName} sign-in is not enabled in authentication settings.`;
    case "auth/popup-closed-by-user":
      return `${providerName} sign-in was cancelled.`;
    case "auth/popup-blocked":
      return "Popup blocked by browser. Trying redirect flow...";
    case "auth/unauthorized-domain":
      return "This domain is not authorized for social authentication.";
    case "auth/account-exists-with-different-credential":
      return "This email already exists with a different sign-in method.";
    case "auth/unsupported-provider":
      return "That social provider is not supported yet.";
    default:
      return `Failed to sign in with ${providerName}. Please try again.`;
  }
}

function redirectToDashboard(delayMs = 1000) {
  setTimeout(() => {
    // If the user was trying to reach a specific page before being redirected
    // to login, take them back there. Otherwise go to dashboard.
    const returnUrl = consumeReturnUrl();
    window.location.href = returnUrl || DASHBOARD_REDIRECT_URL;
  }, delayMs);
}

async function finalizeSocialLogin(result, fallbackProviderName = "Social") {
  if (!result || !result.user) return;

  const providerName =
    (result.metadata && result.metadata.providerName) || fallbackProviderName;

  showToast(`${providerName} login successful`, "success");
  redirectToDashboard();
}

async function startSocialLogin(providerName, triggerButton) {
  setSocialLoading(true, triggerButton, `Connecting ${providerName}...`);

  try {
    const result = await customerAuthService.startSocialLogin(providerName, { mode: "popup" });
    if (result && result.redirected) {
      return;
    }

    await finalizeSocialLogin(result, providerName);
  } catch (error) {
    if (
      error.code === "auth/popup-blocked" ||
      error.code === "auth/operation-not-supported-in-this-environment"
    ) {
      showToast("Popup unavailable. Redirecting to provider sign-in...", "info");
      await customerAuthService.startSocialLogin(providerName, { mode: "redirect" });
      return;
    }

    console.error(`${providerName} login failed:`, error);
    showToast(socialErrorMessage(error, providerName), "error");
  } finally {
    setSocialLoading(false);
  }
}

async function handleRedirectSocialResult() {
  try {
    const result = await customerAuthService.completeSocialLoginRedirect();
    if (!result || !result.user) return;

    await finalizeSocialLogin(result);
  } catch (error) {
    console.error("Redirect social login failed:", error);
    showToast(socialErrorMessage(error, "Social"), "error");
  }
}

function wireEmailPasswordLogin() {
  if (!loginForm || !identifierInput || !passwordInput || !loginBtn) {
    console.error("Login setup failed: one or more form elements are missing.");
    return;
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const identifier = identifierInput.value.trim();
    const password = passwordInput.value;

    if (!identifier || !password) {
      showToast("Enter both identifier and password.", "error");
      return;
    }

    setLoginLoading(true);

    try {
      await customerAuthService.signInWithIdentifier({ identifier, password });
      showToast("Login successful", "success");
      redirectToDashboard();
    } catch (error) {
      console.error("Customer login failed:", error);
      showToast(loginErrorMessage(error), "error");
    } finally {
      setLoginLoading(false);
    }
  });
}

function wireSocialButtons() {
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener("click", () => {
      startSocialLogin("Google", googleLoginBtn);
    });
  }

  if (appleLoginBtn) {
    appleLoginBtn.addEventListener("click", () => {
      startSocialLogin("Apple", appleLoginBtn);
    });
  }

  if (facebookLoginBtn) {
    facebookLoginBtn.addEventListener("click", () => {
      startSocialLogin("Facebook", facebookLoginBtn);
    });
  }
}

wireEmailPasswordLogin();
wireSocialButtons();
void handleRedirectSocialResult();

