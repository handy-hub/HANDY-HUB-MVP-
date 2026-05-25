document.addEventListener('DOMContentLoaded', () => {
    // Signup validation block: only run when the signup DOM is present.
    const signupForm = document.getElementById('signup-form');
    const nameInput = document.getElementById('full-name') || document.querySelector('input[placeholder="Enter your full name"]');
    const emailInput = document.getElementById('email') || document.querySelector('input[placeholder="Enter email"]');
    const passwordInput = document.getElementById('pass');
    const confirmInput = document.getElementById('confirm');
    const termsCheckbox = document.querySelector('.terms-row input[type="checkbox"]') || document.querySelector('input[type="checkbox"]');
    const submitBtn = document.getElementById('submit-btn');
    const hintContainer = document.querySelector('.pass-hint');
    const hintText = hintContainer ? hintContainer.querySelector('span') : null;

    if (
        signupForm &&
        nameInput &&
        emailInput &&
        passwordInput &&
        confirmInput &&
        termsCheckbox &&
        submitBtn &&
        hintContainer &&
        hintText
    ) {
        const checkStrength = (pass) => {
            const hasUpper = /[A-Z]/.test(pass);
            const hasLower = /[a-z]/.test(pass);
            const hasNumber = /[0-9]/.test(pass);
            const hasSymbol = /[!@#$%^&*()-,.?":{}|<>]/.test(pass);
            const isLongEnough = pass.length >= 8;

            if (pass.length === 0) {
                return { message: 'Password must be at least 8 characters', color: '#757575', valid: false };
            }

            if (isLongEnough && hasUpper && hasLower && hasNumber && hasSymbol) {
                return { message: 'Strong password!', color: '#2eb82e', valid: true };
            }

            const missing = [];
            if (!isLongEnough) missing.push('8+ chars');
            if (!hasUpper) missing.push('Uppercase');
            if (!hasLower) missing.push('Lowercase');
            if (!hasNumber) missing.push('Number');
            if (!hasSymbol) missing.push('Symbol');

            return { message: `Missing ${missing.join(', ')}`, color: '#ff4d4d', valid: false };
        };

        const validate = () => {
            const strength = checkStrength(passwordInput.value);
            hintText.innerText = strength.message;
            hintContainer.style.color = strength.color;

            const isNameOk = nameInput.value.trim().length > 0;
            const isEmailOk = emailInput.value.trim().length > 0;
            const isMatch = passwordInput.value === confirmInput.value && passwordInput.value !== '';
            const isTermsOk = termsCheckbox.checked;

            if (isNameOk && isEmailOk && strength.valid && isMatch && isTermsOk) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.backgroundColor = '#800000';
                submitBtn.style.cursor = 'pointer';
            } else {
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.5';
                submitBtn.style.backgroundColor = '#ccc';
                submitBtn.style.cursor = 'not-allowed';
            }
        };

        [nameInput, emailInput, passwordInput, confirmInput, termsCheckbox].forEach((el) => {
            el.addEventListener('input', validate);
            el.addEventListener('change', validate);
        });
    }

    // Eye icon toggle logic (safe on any page that has these icons).
    document.querySelectorAll('.eye-icon').forEach((icon) => {
        icon.addEventListener('click', function onEyeClick() {
            const input = this.parentElement ? this.parentElement.querySelector('input') : null;
            if (!input) return;

            if (input.type === 'password') {
                input.type = 'text';
                this.src = '../shared/assets/icons/icons8-invisible-96.png';
                return;
            }

            input.type = 'password';
            this.src = '../shared/assets/icons/icons8-eye-96.png';
        });
    });
});

// Back button (no hard reload when possible).
const backBtn = document.querySelector('.back-btn');
if (backBtn) {
    backBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = 'index.html';

        try {
            const response = await fetch(url);
            const html = await response.text();
            const parser = new DOMParser();
            const newDoc = parser.parseFromString(html, 'text/html');
            const currentApp = document.querySelector('.app');
            const nextApp = newDoc.querySelector('.app');

            if (currentApp && nextApp) {
                currentApp.innerHTML = nextApp.innerHTML;
                window.history.pushState({}, '', url);
                return;
            }
        } catch (err) {
            console.error('Back navigation prefetch failed:', err);
        }

        window.location.href = url;
    });
}

// Location detection for signup page.
const locationInput = document.getElementById('location');
if (locationInput) {
    async function detectLocation() {
        if (!navigator.geolocation) return;
        locationInput.placeholder = 'Detecting your location...';

        navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            try {
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,
                    { headers: { 'User-Agent': 'HandyHub/1.0' } }
                );
                const data = await response.json();
                const addr = data.address || {};
                const cityArea = addr.city || addr.town || addr.suburb || addr.neighbourhood;
                const country = addr.country || '';
                locationInput.value = cityArea ? `${cityArea}, ${country}` : (data.display_name || '');
                locationInput.dispatchEvent(new Event('input'));
            } catch (error) {
                locationInput.placeholder = 'Enter location manually';
            }
        }, () => {
            locationInput.placeholder = 'Enter location manually';
        }, { enableHighAccuracy: true });
    }

    window.addEventListener('load', detectLocation);
}

// Fast navigation helper for pages that have #main-content.
async function instantNavigate(url) {
    const container = document.getElementById('main-content');
    if (!container) {
        window.location.href = url;
        return;
    }

    try {
        const response = await fetch(url);
        const text = await response.text();
        const parser = new DOMParser();
        const newDoc = parser.parseFromString(text, 'text/html');
        const newMain = newDoc.getElementById('main-content');

        if (!newMain) {
            window.location.href = url;
            return;
        }

        container.innerHTML = newMain.innerHTML;
        window.history.pushState({}, '', url);
    } catch (error) {
        console.error('Fast navigation failed, falling back:', error);
        window.location.href = url;
    }
}

// Delegated click handling for branch choice buttons.
document.addEventListener('click', (e) => {
    const customerBtn = e.target.closest('#continue-customer');
    if (customerBtn) {
        e.preventDefault();
        window.location.href = 'signup.html';
        return;
    }

    const artisanBtn = e.target.closest('#continue-artisan');
    if (artisanBtn) {
        e.preventDefault();
        instantNavigate('../artisan-app/onboarding.html');
    }
});
