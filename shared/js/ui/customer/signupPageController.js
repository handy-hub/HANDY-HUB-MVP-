import "../../utils/global-app.js";
import { getAppContainer } from "../../app/container.js";
import { showToast } from "../../components/toast.js";
import { checkAndRecord, showRateLimitToast } from "../../services/rateLimitService.js";

const SIGNUP_BUTTON_TEXT = "Sign Up ->";
const SIGNUP_BUTTON_LOADING_TEXT = "Creating Account...";
const LOGIN_REDIRECT_URL = "login.html";
const SOCIAL_REDIRECT_URL = "index.html";

const {
  services: { customerAuthService }
} = getAppContainer();

// UI layer: DOM event handling lives here, isolated from backend/provider code.
const signupForm = document.getElementById("signup-form");
const fullNameInput = document.getElementById("full-name");
const emailInput = document.getElementById("email");
const phoneInput = document.getElementById("tel-no");
const locationInput = document.getElementById("location");
const passwordInput = document.getElementById("pass");
const confirmPasswordInput = document.getElementById("confirm");
const termsCheckbox = document.querySelector(".terms-row input[type=\"checkbox\"]");
const submitBtn = document.getElementById("submit-btn");

const googleSignupBtn = document.getElementById("google-signup-btn");
const appleSignupBtn = document.getElementById("apple-signup-btn");
const facebookSignupBtn = document.getElementById("facebook-signup-btn");
const socialButtons = [googleSignupBtn, appleSignupBtn, facebookSignupBtn].filter(Boolean);

const requiredFormElements = [
  signupForm,
  fullNameInput,
  emailInput,
  phoneInput,
  locationInput,
  passwordInput,
  confirmPasswordInput,
  termsCheckbox,
  submitBtn
];

socialButtons.forEach((button) => {
  button.dataset.defaultHtml = button.innerHTML;
});

if (submitBtn) {
  submitBtn.dataset.defaultHtml = submitBtn.innerHTML;
}

function createButtonLoadingHtml(label) {
  return `${label}<span class="button-loader" aria-hidden="true"></span>`;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

function updateSubmitButtonState(isEnabled) {
  if (!submitBtn) return;
  submitBtn.disabled = !isEnabled;
  submitBtn.style.opacity = isEnabled ? "1" : "0.6";
  submitBtn.style.cursor = isEnabled ? "pointer" : "not-allowed";
}

function setSubmitLoading(isLoading) {
  if (!submitBtn) return;
  submitBtn.disabled = isLoading;
  submitBtn.style.opacity = isLoading ? "0.7" : "1";
  submitBtn.style.cursor = isLoading ? "not-allowed" : "pointer";
  if (isLoading) {
    submitBtn.innerHTML = createButtonLoadingHtml(SIGNUP_BUTTON_LOADING_TEXT);
  } else {
    submitBtn.innerHTML = submitBtn.dataset.defaultHtml || SIGNUP_BUTTON_TEXT;
  }
}

function setSocialButtonsLoading(isLoading, activeButton = null, activeLabel = "Please wait...") {
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

function collectProfileInput() {
  return {
    fullName: fullNameInput ? fullNameInput.value.trim() : "",
    email: emailInput ? emailInput.value.trim() : "",
    phone: phoneInput ? phoneInput.value.trim() : "",
    location: (locationInput && locationInput.value.trim()) || "Not specified"
  };
}

function signupErrorMessage(error) {
  switch (error.code) {
    case "auth/email-already-in-use":
      return "This email is already registered. Please login instead.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/operation-not-allowed":
      return "Email/password signup is disabled. Please contact support.";
    case "firestore/permission-denied":
    case "permission-denied":
      return "Customer profile write was denied. Check backend rules for customers.";
    default:
      return "Failed to create account. Please try again.";
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
      return `Failed to sign up with ${providerName}. Please try again.`;
  }
}

async function redirectAfterSuccess(url, delayMs = 1200) {
  setTimeout(() => {
    window.location.href = url;
  }, delayMs);
}

async function startSocialSignup(providerName, triggerButton) {
  setSocialButtonsLoading(true, triggerButton, `Connecting ${providerName}...`);

  try {
    const profileInput = collectProfileInput();
    const result = await customerAuthService.startSocialSignup(
      providerName,
      profileInput,
      { mode: "popup" }
    );

    if (result && result.redirected) {
      return;
    }

    const successMessage = result && result.metadata && result.metadata.isNewUser
      ? `${providerName} signup successful! Redirecting...`
      : `${providerName} sign-in successful! Redirecting...`;

    showToast(successMessage, "success");
    await redirectAfterSuccess(SOCIAL_REDIRECT_URL);
  } catch (error) {
    if (
      error.code === "auth/popup-blocked" ||
      error.code === "auth/operation-not-supported-in-this-environment"
    ) {
      showToast("Popup unavailable. Redirecting to provider sign-in...", "info");
      await customerAuthService.startSocialSignup(
        providerName,
        collectProfileInput(),
        { mode: "redirect" }
      );
      return;
    }

    console.error(`${providerName} signup failed:`, error);
    showToast(socialErrorMessage(error, providerName), "error");
  } finally {
    setSocialButtonsLoading(false);
  }
}

async function handleRedirectSocialSignup() {
  try {
    const result = await customerAuthService.completeSocialSignupRedirect(collectProfileInput());
    if (!result || !result.user) return;

    const providerName = result.metadata && result.metadata.providerName
      ? result.metadata.providerName
      : "Social";

    const successMessage = result.metadata && result.metadata.isNewUser
      ? `${providerName} signup successful! Redirecting...`
      : `${providerName} sign-in successful! Redirecting...`;

    showToast(successMessage, "success");
    await redirectAfterSuccess(SOCIAL_REDIRECT_URL);
  } catch (error) {
    console.error("Redirect signup failed:", error);
    showToast(socialErrorMessage(error, "Social"), "error");
  }
}

function wireSocialButtons() {
  if (googleSignupBtn) {
    googleSignupBtn.addEventListener("click", () => {
      startSocialSignup("Google", googleSignupBtn);
    });
  }

  if (appleSignupBtn) {
    appleSignupBtn.addEventListener("click", () => {
      startSocialSignup("Apple", appleSignupBtn);
    });
  }

  if (facebookSignupBtn) {
    facebookSignupBtn.addEventListener("click", () => {
      startSocialSignup("Facebook", facebookSignupBtn);
    });
  }
}

function setupEmailSignupForm() {
  if (!requiredFormElements.every(Boolean)) {
    console.error("Auth setup failed: one or more signup form elements are missing.");
    return;
  }

  function validateForm() {
    const fullName = fullNameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;
    const isTermsChecked = termsCheckbox.checked;

    const isFullNameValid = fullName.length >= 2;
    const isEmailValid = isValidEmail(email);
    const isPhoneValid = phone === "" || phone.length >= 10;
    const isPasswordValid = password.length >= 8;
    const isPasswordMatch = password === confirmPassword && password !== "";
    const isTermsValid = isTermsChecked;

    updateSubmitButtonState(
      isFullNameValid &&
      isEmailValid &&
      isPhoneValid &&
      isPasswordValid &&
      isPasswordMatch &&
      isTermsValid
    );
  }

  fullNameInput.addEventListener("input", validateForm);
  emailInput.addEventListener("input", validateForm);
  phoneInput.addEventListener("input", validateForm);
  locationInput.addEventListener("input", validateForm);
  passwordInput.addEventListener("input", validateForm);
  confirmPasswordInput.addEventListener("input", validateForm);
  termsCheckbox.addEventListener("change", validateForm);
  validateForm();

  confirmPasswordInput.addEventListener("input", () => {
    if (passwordInput.value !== confirmPasswordInput.value) {
      confirmPasswordInput.style.border = "2px solid red";
      return;
    }
    confirmPasswordInput.style.border = "2px solid green";
  });

  passwordInput.addEventListener("input", () => {
    if (passwordInput.value.length < 8) {
      passwordInput.style.border = "2px solid orange";
      return;
    }
    passwordInput.style.border = "2px solid green";
  });

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const profileInput = collectProfileInput();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (password !== confirmPassword) {
      showToast("Passwords do not match!", "error");
      return;
    }

    if (password.length < 8) {
      showToast("Password must be at least 8 characters long!", "error");
      return;
    }

    if (!termsCheckbox.checked) {
      showToast("Please accept the terms before signing up.", "error");
      return;
    }

    if (profileInput.phone !== "" && profileInput.phone.length < 10) {
      showToast("Phone number must be at least 10 digits or left blank.", "error");
      return;
    }

    // Frontend rate limit: 3 signups per 10 minutes (keyed by device fingerprint)
    const rl = checkAndRecord("SIGNUP_ATTEMPT", null);
    if (!rl.allowed) {
      showRateLimitToast(rl.waitMs, "auth");
      return;
    }

    setSubmitLoading(true);

    try {
      await customerAuthService.signUpWithEmail({
        ...profileInput,
        password
      });

      showToast("Account created successfully! Redirecting...", "success");
      signupForm.reset();
      updateSubmitButtonState(false);
      await redirectAfterSuccess(LOGIN_REDIRECT_URL, 2000);
    } catch (error) {
      console.error("Signup failed:", error);
      showToast(signupErrorMessage(error), "error");
      setSubmitLoading(false);
      validateForm();
    }
  });
}

export function bootstrapCustomerSignupPage() {
  wireSocialButtons();
  setupEmailSignupForm();
  void handleRedirectSocialSignup();
}

bootstrapCustomerSignupPage();

