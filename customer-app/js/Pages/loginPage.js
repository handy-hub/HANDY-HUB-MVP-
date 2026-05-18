import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";

const DASHBOARD_REDIRECT_URL = "dashboard.html";
const LOGIN_LOADING_TEXT = "Logging in...";
const TOAST_DISMISS_DELAY_MS = 3000;
const TOAST_EXIT_DURATION_MS = 320;
const TOAST_ICONS = Object.freeze({
  success:
    "<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M20 7L10.25 16.75L6 12.5\" stroke=\"currentColor\" stroke-width=\"2.25\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
  error:
    "<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 8V13\" stroke=\"currentColor\" stroke-width=\"2.25\" stroke-linecap=\"round\"/><path d=\"M12 16.5V16.55\" stroke=\"currentColor\" stroke-width=\"2.25\" stroke-linecap=\"round\"/><path d=\"M10.29 3.86L1.82 18A2 2 0 0 0 3.53 21H20.47A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
  info:
    "<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"12\" cy=\"12\" r=\"9\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M12 10V16\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><path d=\"M12 7.6V7.65\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/></svg>"
});

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

function createToastIcon(type) {
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  return icon;
}

function showToast(message, type = "error") {
  const existingToast = document.querySelector(".toast");
  if (existingToast) {
    existingToast.remove();
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", "polite");

  const toastMessage = document.createElement("span");
  toastMessage.className = "toast-message";
  toastMessage.textContent = message;

  toast.appendChild(createToastIcon(type));
  toast.appendChild(toastMessage);
  document.body.appendChild(toast);

  const removeToast = () => {
    toast.remove();
  };

  setTimeout(() => {
    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", removeToast, { once: true });
    setTimeout(removeToast, TOAST_EXIT_DURATION_MS);
  }, TOAST_DISMISS_DELAY_MS);
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
    window.location.href = DASHBOARD_REDIRECT_URL;
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
