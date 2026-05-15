import { auth, db } from './firebase-config.js';
import {
    FacebookAuthProvider,
    getAdditionalUserInfo,
    getRedirectResult,
    GoogleAuthProvider,
    OAuthProvider,
    signInWithEmailAndPassword,
    signInWithPopup,
    signInWithRedirect
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    setDoc,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const CUSTOMER_COLLECTION = 'customers';
const DASHBOARD_REDIRECT_URL = 'index.html';
const LOGIN_BUTTON_TEXT = 'Login ->';
const LOGIN_LOADING_TEXT = 'Signing in...';

const loginForm = document.getElementById('login-form');
const identifierInput = document.getElementById('user-id');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');

const googleLoginBtn = document.getElementById('google-login-btn');
const appleLoginBtn = document.getElementById('apple-login-btn');
const facebookLoginBtn = document.getElementById('facebook-login-btn');
const socialButtons = [googleLoginBtn, appleLoginBtn, facebookLoginBtn].filter(Boolean);

socialButtons.forEach((button) => {
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

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
}

function normalizePhone(value) {
    return (value || '').replace(/[^\d+]/g, '').trim();
}

function setLoginLoading(isLoading) {
    if (!loginBtn) return;
    loginBtn.disabled = isLoading;
    loginBtn.style.opacity = isLoading ? '0.7' : '1';
    loginBtn.style.cursor = isLoading ? 'not-allowed' : 'pointer';
    loginBtn.textContent = isLoading ? LOGIN_LOADING_TEXT : LOGIN_BUTTON_TEXT;
}

function setSocialLoading(isLoading, activeButton = null, activeLabel = 'Please wait...') {
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

async function getEmailFromPhone(phoneInputValue) {
    const candidates = Array.from(
        new Set([
            (phoneInputValue || '').trim(),
            normalizePhone(phoneInputValue)
        ].filter(Boolean))
    );

    if (!candidates.length) {
        throw Object.assign(new Error('Missing phone value.'), { code: 'auth/invalid-phone-value' });
    }

    for (const candidate of candidates) {
        const phoneQuery = query(collection(db, CUSTOMER_COLLECTION), where('phone', '==', candidate));
        const snapshot = await getDocs(phoneQuery);
        if (!snapshot.empty) {
            const email = (snapshot.docs[0].data().email || '').trim().toLowerCase();
            if (isValidEmail(email)) {
                return email;
            }
        }
    }

    throw Object.assign(
        new Error('No account found for that phone number.'),
        { code: 'auth/customer-not-found' }
    );
}

async function resolveEmailIdentifier(identifier) {
    const cleaned = (identifier || '').trim();
    if (!cleaned) {
        throw Object.assign(new Error('Missing identifier.'), { code: 'auth/missing-identifier' });
    }

    if (isValidEmail(cleaned)) {
        return cleaned.toLowerCase();
    }

    return getEmailFromPhone(cleaned);
}

async function ensureCustomerProfile(user) {
    try {
        const customerRef = doc(db, CUSTOMER_COLLECTION, user.uid);
        const snapshot = await getDoc(customerRef);
        if (snapshot.exists()) return;

        const nowIso = new Date().toISOString();
        const fallbackName = (user.displayName || user.email || 'Customer').trim();

        await setDoc(customerRef, {
            bookings: 0,
            createdAt: nowIso,
            email: (user.email || '').trim().toLowerCase(),
            id: user.uid,
            joined: nowIso,
            location: 'Not specified',
            name: fallbackName.includes('@') ? fallbackName.split('@')[0] : fallbackName,
            phone: '',
            spent: 0,
            status: 'active',
            userType: 'customer'
        }, { merge: true });
    } catch (error) {
        // Login should not fail if profile hydration is blocked by rules.
        console.warn('Customer profile ensure failed:', error);
    }
}

function loginErrorMessage(error) {
    switch (error.code) {
        case 'auth/missing-identifier':
            return 'Enter your email or phone number.';
        case 'auth/invalid-phone-value':
            return 'Enter a valid phone number.';
        case 'auth/customer-not-found':
            return 'No customer account found for that phone number.';
        case 'permission-denied':
        case 'firestore/permission-denied':
            return 'Phone lookup is not allowed right now. Please login with your email.';
        case 'auth/invalid-email':
            return 'Please enter a valid email address.';
        case 'auth/wrong-password':
            return 'Incorrect email/phone or password.';
        case 'auth/invalid-credential':
            return 'Incorrect email/phone or password.';
        case 'auth/user-disabled':
            return 'This account has been disabled.';
        case 'auth/too-many-requests':
            return 'Too many failed attempts. Please wait and try again.';
        case 'auth/network-request-failed':
            return 'Network error. Check your internet connection and try again.';
        default:
            return 'Login failed. Please try again.';
    }
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
        default:
            return `Failed to sign in with ${providerName}. Please try again.`;
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

async function finalizeSocialLogin(result, providerName) {
    if (!result || !result.user) return;
    await ensureCustomerProfile(result.user);
    showToast(`${providerName} login successful! Redirecting...`, 'success');
    setTimeout(() => {
        window.location.href = DASHBOARD_REDIRECT_URL;
    }, 1000);
}

async function startSocialLogin(providerName, triggerButton) {
    const provider = providerFor(providerName);
    setSocialLoading(true, triggerButton, `Connecting ${providerName}...`);

    try {
        const result = await signInWithPopup(auth, provider);
        await finalizeSocialLogin(result, providerName);
    } catch (error) {
        if (
            error.code === 'auth/popup-blocked' ||
            error.code === 'auth/operation-not-supported-in-this-environment'
        ) {
            showToast('Popup unavailable. Redirecting to provider sign-in...', 'info');
            await signInWithRedirect(auth, provider);
            return;
        }

        console.error(`${providerName} login failed:`, error);
        showToast(socialErrorMessage(error, providerName), 'error');
    } finally {
        setSocialLoading(false);
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

        await finalizeSocialLogin(result, providerName);
    } catch (error) {
        console.error('Redirect social login failed:', error);
        showToast(socialErrorMessage(error, 'Social'), 'error');
    }
}

if (!loginForm || !identifierInput || !passwordInput || !loginBtn) {
    console.error('Login setup failed: one or more form elements are missing.');
} else {
    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const identifier = identifierInput.value.trim();
        const password = passwordInput.value;

        if (!identifier || !password) {
            showToast('Enter both identifier and password.', 'error');
            return;
        }

        setLoginLoading(true);

        try {
            const email = await resolveEmailIdentifier(identifier);
            const credential = await signInWithEmailAndPassword(auth, email, password);

            await ensureCustomerProfile(credential.user);
            showToast('Login successful! Redirecting...', 'success');

            setTimeout(() => {
                window.location.href = DASHBOARD_REDIRECT_URL;
            }, 1000);
        } catch (error) {
            console.error('Customer login failed:', error);
            showToast(loginErrorMessage(error), 'error');
        } finally {
            setLoginLoading(false);
        }
    });
}

if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', () => {
        startSocialLogin('Google', googleLoginBtn);
    });
}

if (appleLoginBtn) {
    appleLoginBtn.addEventListener('click', () => {
        startSocialLogin('Apple', appleLoginBtn);
    });
}

if (facebookLoginBtn) {
    facebookLoginBtn.addEventListener('click', () => {
        startSocialLogin('Facebook', facebookLoginBtn);
    });
}

void handleRedirectSocialResult();
