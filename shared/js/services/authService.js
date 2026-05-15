// auth.js
import { auth, db, firestoreDatabaseId } from '../firebase/firebaseConfig.js';
import {
    createUserWithEmailAndPassword,
    deleteUser,
    FacebookAuthProvider,
    getAdditionalUserInfo,
    getRedirectResult,
    GoogleAuthProvider,
    OAuthProvider,
    signInWithPopup,
    signInWithRedirect
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc,
    getDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const SIGNUP_BUTTON_TEXT = 'Sign Up ->';
const SIGNUP_BUTTON_LOADING_TEXT = 'Creating Account...';
const LOGIN_REDIRECT_URL = 'login.html';
const SOCIAL_REDIRECT_URL = 'index.html';
const CUSTOMER_COLLECTION = 'customers';

// DOM Elements (email signup)
const signupForm = document.getElementById('signup-form');
const fullNameInput = document.getElementById('full-name');
const emailInput = document.getElementById('email');
const phoneInput = document.getElementById('tel-no');
const locationInput = document.getElementById('location');
const passwordInput = document.getElementById('pass');
const confirmPasswordInput = document.getElementById('confirm');
const termsCheckbox = document.querySelector('.terms-row input[type="checkbox"]');
const submitBtn = document.getElementById('submit-btn');

// DOM Elements (social signup)
const googleSignupBtn = document.getElementById('google-signup-btn');
const appleSignupBtn = document.getElementById('apple-signup-btn');
const facebookSignupBtn = document.getElementById('facebook-signup-btn');
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
    button.dataset.defaultLabel = button.textContent.trim();
    button.dataset.defaultHtml = button.innerHTML;
});

function showToast(message, type = 'error') {
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3000);
}

function updateSubmitButtonState(isEnabled) {
    if (!submitBtn) return;
    submitBtn.disabled = !isEnabled;
    submitBtn.style.opacity = isEnabled ? '1' : '0.6';
    submitBtn.style.cursor = isEnabled ? 'pointer' : 'not-allowed';
}

function setSocialButtonsLoading(isLoading, activeButton = null, activeLabel = 'Please wait...') {
    socialButtons.forEach((button) => {
        button.disabled = isLoading;
        button.style.opacity = isLoading ? '0.7' : '1';
        button.style.cursor = isLoading ? 'not-allowed' : 'pointer';
        if (!isLoading && button.dataset.defaultHtml) {
            button.innerHTML = button.dataset.defaultHtml;
        }
    });

    if (isLoading && activeButton) {
        activeButton.textContent = activeLabel;
    }
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
}

function buildCustomerData(user, fullName, email, phone, location, createdAtOverride) {
    const nowIso = createdAtOverride || new Date().toISOString();

    return {
        bookings: 0,
        createdAt: nowIso,
        email,
        id: user.uid,
        joined: nowIso,
        location,
        name: fullName,
        phone,
        spent: 0,
        status: 'active',
        userType: 'customer'
    };
}

async function verifyCustomerWrite(userId) {
    const customerRef = doc(db, CUSTOMER_COLLECTION, userId);
    const snapshot = await getDoc(customerRef);

    if (!snapshot.exists()) {
        throw new Error('Customer document verification failed: write not found after setDoc.');
    }

    console.log('[Firestore Check] write verified', {
        projectId: db.app.options.projectId,
        databaseId: firestoreDatabaseId,
        path: `${CUSTOMER_COLLECTION}/${userId}`
    });
}

function deriveCustomerName(user, formName) {
    const displayName = (user.displayName || '').trim();
    if (displayName) return displayName;

    const nameFromForm = (formName || '').trim();
    if (nameFromForm) return nameFromForm;

    const email = (user.email || '').trim();
    if (email.includes('@')) return email.split('@')[0];

    return 'Customer';
}

async function upsertSocialCustomerProfile(user) {
    const email = (user.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
        throw Object.assign(new Error('Email is required for social signup.'), { code: 'auth/social-missing-email' });
    }

    const name = deriveCustomerName(user, fullNameInput ? fullNameInput.value : '');
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const location = (locationInput && locationInput.value.trim()) || 'Not specified';
    const customerRef = doc(db, CUSTOMER_COLLECTION, user.uid);
    const snapshot = await getDoc(customerRef);

    if (!snapshot.exists()) {
        await setDoc(customerRef, buildCustomerData(user, name, email, phone, location));
        return;
    }

    const existing = snapshot.data() || {};
    const nowIso = new Date().toISOString();
    const safeStatus = typeof existing.status === 'string' && ['active', 'suspended'].includes(existing.status)
        ? existing.status
        : 'active';

    const patch = {
        id: user.uid,
        email: isValidEmail(existing.email) ? existing.email : email,
        name: typeof existing.name === 'string' && existing.name.trim() ? existing.name : name,
        userType: 'customer',
        status: safeStatus,
        bookings: typeof existing.bookings === 'number' ? existing.bookings : 0,
        spent: typeof existing.spent === 'number' ? existing.spent : 0,
        createdAt: typeof existing.createdAt === 'string' && existing.createdAt ? existing.createdAt : nowIso,
        joined: typeof existing.joined === 'string' && existing.joined ? existing.joined : nowIso,
        location: typeof existing.location === 'string' && existing.location ? existing.location : location,
        phone: typeof existing.phone === 'string' ? existing.phone : phone
    };

    await setDoc(customerRef, patch, { merge: true });
}

function socialErrorMessage(error, providerName) {
    switch (error.code) {
        case 'auth/operation-not-allowed':
            return `${providerName} sign-in is not enabled in Firebase Authentication settings.`;
        case 'auth/popup-closed-by-user':
            return `${providerName} sign-in was cancelled.`;
        case 'auth/popup-blocked':
            return 'Popup blocked by browser. Trying redirect flow...';
        case 'auth/unauthorized-domain':
            return 'This domain is not authorized in Firebase Authentication.';
        case 'auth/account-exists-with-different-credential':
            return 'This email already exists with a different sign-in method.';
        case 'firestore/permission-denied':
            return 'Customer profile write was denied. Check Firestore rules for "customers/{uid}".';
        case 'auth/social-missing-email':
            return `${providerName} did not return an email. Please use email signup or another provider.`;
        default:
            return `Failed to sign up with ${providerName}. Please try again.`;
    }
}

function providerFor(name) {
    if (name === 'Google') {
        const provider = new GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        return provider;
    }

    if (name === 'Facebook') {
        const provider = new FacebookAuthProvider();
        provider.addScope('email');
        return provider;
    }

    const provider = new OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    return provider;
}

async function finalizeSocialSignup(userCredential, providerName) {
    const info = getAdditionalUserInfo(userCredential);
    const isNewUser = Boolean(info && info.isNewUser);

    try {
        await upsertSocialCustomerProfile(userCredential.user);
        await verifyCustomerWrite(userCredential.user.uid);
    } catch (error) {
        if (isNewUser && auth.currentUser) {
            try {
                await deleteUser(auth.currentUser);
            } catch (rollbackError) {
                console.error('Auth rollback failed after social Firestore error:', rollbackError);
            }
        }
        throw error;
    }

    const successMessage = isNewUser
        ? `${providerName} signup successful! Redirecting...`
        : `${providerName} sign-in successful! Redirecting...`;

    showToast(successMessage, 'success');
    setTimeout(() => {
        window.location.href = SOCIAL_REDIRECT_URL;
    }, 1200);
}

async function startSocialSignup(providerName, triggerButton) {
    const provider = providerFor(providerName);
    setSocialButtonsLoading(true, triggerButton, `Connecting ${providerName}...`);

    try {
        const result = await signInWithPopup(auth, provider);
        await finalizeSocialSignup(result, providerName);
    } catch (error) {
        if (
            error.code === 'auth/popup-blocked' ||
            error.code === 'auth/operation-not-supported-in-this-environment'
        ) {
            showToast('Popup unavailable. Redirecting to provider sign-in...', 'success');
            await signInWithRedirect(auth, provider);
            return;
        }

        console.error(`${providerName} signup failed:`, error);
        showToast(socialErrorMessage(error, providerName), 'error');
    } finally {
        setSocialButtonsLoading(false);
    }
}

async function handleRedirectSocialResult() {
    try {
        const result = await getRedirectResult(auth);
        if (!result || !result.user) return;

        const additionalInfo = getAdditionalUserInfo(result);
        const providerId = (additionalInfo && additionalInfo.providerId) || '';
        const providerName = providerId === 'google.com'
            ? 'Google'
            : providerId === 'facebook.com'
                ? 'Facebook'
                : providerId === 'apple.com'
                    ? 'Apple'
                    : 'Social';

        await finalizeSocialSignup(result, providerName);
    } catch (error) {
        console.error('Redirect signup failed:', error);
        showToast(socialErrorMessage(error, 'Social'), 'error');
    }
}

if (googleSignupBtn) {
    googleSignupBtn.addEventListener('click', () => {
        startSocialSignup('Google', googleSignupBtn);
    });
}

if (appleSignupBtn) {
    appleSignupBtn.addEventListener('click', () => {
        startSocialSignup('Apple', appleSignupBtn);
    });
}

if (facebookSignupBtn) {
    facebookSignupBtn.addEventListener('click', () => {
        startSocialSignup('Facebook', facebookSignupBtn);
    });
}

void handleRedirectSocialResult();

if (!requiredFormElements.every(Boolean)) {
    console.error('Auth setup failed: one or more signup form elements are missing.');
} else {
    function validateForm() {
        const fullName = fullNameInput.value.trim();
        const email = emailInput.value.trim();
        const phone = phoneInput.value.trim();
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;
        const isTermsChecked = termsCheckbox.checked;

        const isFullNameValid = fullName.length >= 2;
        const isEmailValid = isValidEmail(email);
        const isPhoneValid = phone === '' || phone.length >= 10;
        const isPasswordValid = password.length >= 8;
        const isPasswordMatch = password === confirmPassword && password !== '';
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

    fullNameInput.addEventListener('input', validateForm);
    emailInput.addEventListener('input', validateForm);
    phoneInput.addEventListener('input', validateForm);
    locationInput.addEventListener('input', validateForm);
    passwordInput.addEventListener('input', validateForm);
    confirmPasswordInput.addEventListener('input', validateForm);
    termsCheckbox.addEventListener('change', validateForm);

    validateForm();

    confirmPasswordInput.addEventListener('input', () => {
        if (passwordInput.value !== confirmPasswordInput.value) {
            confirmPasswordInput.style.border = '2px solid red';
            return;
        }
        confirmPasswordInput.style.border = '2px solid green';
    });

    passwordInput.addEventListener('input', () => {
        if (passwordInput.value.length < 8) {
            passwordInput.style.border = '2px solid orange';
            return;
        }
        passwordInput.style.border = '2px solid green';
    });

    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const fullName = fullNameInput.value.trim();
        const email = emailInput.value.trim();
        const phone = phoneInput.value.trim();
        const location = locationInput.value.trim() || 'Not specified';
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;

        if (password !== confirmPassword) {
            showToast('Passwords do not match!', 'error');
            return;
        }

        if (password.length < 8) {
            showToast('Password must be at least 8 characters long!', 'error');
            return;
        }

        if (!termsCheckbox.checked) {
            showToast('Please accept the terms before signing up.', 'error');
            return;
        }

        if (phone !== '' && phone.length < 10) {
            showToast('Phone number must be at least 10 digits or left blank.', 'error');
            return;
        }

        updateSubmitButtonState(false);
        submitBtn.textContent = SIGNUP_BUTTON_LOADING_TEXT;

        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            const customerData = buildCustomerData(user, fullName, email, phone, location);

            await setDoc(doc(db, CUSTOMER_COLLECTION, user.uid), customerData);
            await verifyCustomerWrite(user.uid);

            submitBtn.textContent = SIGNUP_BUTTON_TEXT;
            showToast('Account created successfully! Redirecting...', 'success');

            signupForm.reset();
            validateForm();

            setTimeout(() => {
                window.location.href = LOGIN_REDIRECT_URL;
            }, 2000);
        } catch (error) {
            console.error('Signup failed:', error);

            if (error.code && error.code.startsWith('firestore/') && auth.currentUser) {
                try {
                    await deleteUser(auth.currentUser);
                } catch (rollbackError) {
                    console.error('Auth rollback failed after Firestore write error:', rollbackError);
                }
            }

            let errorMessage = 'Failed to create account. Please try again.';

            switch (error.code) {
                case 'auth/email-already-in-use':
                    errorMessage = 'This email is already registered. Please login instead.';
                    break;
                case 'auth/invalid-email':
                    errorMessage = 'Please enter a valid email address.';
                    break;
                case 'auth/weak-password':
                    errorMessage = 'Password should be at least 6 characters.';
                    break;
                case 'auth/operation-not-allowed':
                    errorMessage = 'Email/password signup is disabled. Please contact support.';
                    break;
                case 'firestore/permission-denied':
                    errorMessage = 'Customer profile write was denied. Check Firestore rules for "customers/{uid}".';
                    break;
                default:
                    break;
            }

            showToast(errorMessage, 'error');
            submitBtn.textContent = SIGNUP_BUTTON_TEXT;
            validateForm();
        }
    });
}
