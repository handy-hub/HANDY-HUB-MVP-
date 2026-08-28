/**
 * shared/js/ui/otpVerifyController.js
 *
 * Shared OTP verification page controller used by both customer and artisan apps.
 * Reads sessionId + email from sessionStorage (written by the signup page).
 * Calls verifySignupOtp / resendSignupOtp Cloud Functions.
 * On success: clears sessionStorage and redirects to the app's dashboard.
 *
 * Usage (in verify-email.html inline module script):
 *
 *   import { bootstrapOtpVerifyPage } from '../../shared/js/ui/otpVerifyController.js';
 *   bootstrapOtpVerifyPage({
 *     appType:        'customer',                  // or 'artisan'
 *     successRedirect: '../customer-app/index.html',
 *     restartRedirect: 'signup.html',
 *   });
 */

import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { getApp }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, signInWithCustomToken }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { showToast }
    from '../components/toast.js';

const FUNCTIONS_REGION = 'europe-west1';
const SESSION_KEY      = 'hh_otp_session';
const RESEND_COOLDOWN_S = 60;

let _functions = null;
function getFn() {
    if (!_functions) _functions = getFunctions(getApp(), FUNCTIONS_REGION);
    return _functions;
}

// ── Session storage helpers (never localStorage) ──────────────────────────────
function loadSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
}

// ── DOM ───────────────────────────────────────────────────────────────────────
function getInputs() {
    return Array.from(document.querySelectorAll('[data-otp-input]'));
}

function getOtpValue() {
    return getInputs().map(i => i.value).join('');
}

function clearOtpInputs() {
    getInputs().forEach((el, i) => {
        el.value = '';
        if (i === 0) el.focus();
    });
}

function focusFirstEmpty() {
    const inputs = getInputs();
    const empty = inputs.find(i => !i.value);
    (empty || inputs[inputs.length - 1]).focus();
}

// ── Wire OTP digit input behaviour ────────────────────────────────────────────
function wireOtpInputs(onComplete) {
    const inputs = getInputs();
    if (inputs.length !== 6) return;

    inputs.forEach((input, idx) => {
        // Allow only digits
        input.addEventListener('input', (e) => {
            const raw = e.target.value.replace(/\D/g, '');
            input.value = raw.slice(-1);  // keep only last digit typed
            if (input.value && idx < inputs.length - 1) {
                inputs[idx + 1].focus();
            }
            if (getOtpValue().length === 6) onComplete();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && idx > 0) {
                inputs[idx - 1].focus();
            }
            if (e.key === 'ArrowLeft'  && idx > 0) { e.preventDefault(); inputs[idx - 1].focus(); }
            if (e.key === 'ArrowRight' && idx < inputs.length - 1) { e.preventDefault(); inputs[idx + 1].focus(); }
        });

        // Handle paste on any input — distribute digits
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData || window.clipboardData)
                .getData('text').replace(/\D/g, '').slice(0, 6);
            pasted.split('').forEach((ch, i) => {
                if (inputs[i]) inputs[i].value = ch;
            });
            if (pasted.length === 6) {
                inputs[5].focus();
                onComplete();
            } else if (inputs[pasted.length]) {
                inputs[pasted.length].focus();
            }
        });
    });

    // Focus first input on load
    if (inputs[0]) inputs[0].focus();
}

// ── Resend countdown ──────────────────────────────────────────────────────────
let _countdownTimer = null;

function startResendCountdown(countdownEl, resendBtn) {
    // Cancel any previous chain before starting a new one
    if (_countdownTimer !== null) {
        clearTimeout(_countdownTimer);
        _countdownTimer = null;
    }

    let remaining = RESEND_COOLDOWN_S;
    if (resendBtn) resendBtn.disabled = true;

    const tick = () => {
        if (countdownEl) countdownEl.textContent = remaining;
        if (remaining <= 0) {
            _countdownTimer = null;
            if (resendBtn) {
                resendBtn.disabled = false;
                resendBtn.setAttribute('aria-disabled', 'false');
            }
            if (countdownEl?.parentElement) {
                countdownEl.parentElement.style.display = 'none';
            }
            return;
        }
        remaining--;
        _countdownTimer = setTimeout(tick, 1000);
    };
    tick();
}

// ── Main bootstrap ────────────────────────────────────────────────────────────
export function bootstrapOtpVerifyPage({ appType, successRedirect, restartRedirect, loginRedirect }) {
    // loginRedirect is where we send the user if the account was created but the
    // client sign-in could not be completed (they must log in manually).
    const _loginRedirect = loginRedirect || 'login.html';
    const session = loadSession();

    // Redirect to signup if there's no pending session
    if (!session || !session.sessionId || !session.email) {
        window.location.replace(restartRedirect);
        return;
    }

    // ── Populate masked email display ─────────────────────────────────────────
    const emailDisplay = document.getElementById('otp-email-display');
    if (emailDisplay) {
        const [user, domain] = session.email.split('@');
        const masked = user.slice(0, 2) + '***@' + domain;
        emailDisplay.textContent = masked;
    }

    // ── Wire inputs ───────────────────────────────────────────────────────────
    const submitBtn   = document.getElementById('otp-submit-btn');
    const resendBtn   = document.getElementById('otp-resend-btn');
    const countdownEl = document.getElementById('otp-countdown');
    const loadingEl   = document.getElementById('otp-loading');
    const errorEl     = document.getElementById('otp-error');

    function setLoading(active) {
        if (submitBtn) submitBtn.disabled = active;
        if (loadingEl) loadingEl.hidden = !active;
        getInputs().forEach(i => { i.disabled = active; });
    }

    function showError(msg) {
        if (errorEl) {
            errorEl.textContent = msg;
            errorEl.hidden = false;
            errorEl.setAttribute('role', 'alert');
        }
        showToast(msg, 'error');
    }

    function clearError() {
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.hidden = true;
        }
    }

    let _submitting = false;

    async function submitOtp() {
        if (_submitting) return;

        const otp = getOtpValue();
        if (otp.length !== 6) {
            showError('Please enter the complete 6-digit code.');
            focusFirstEmpty();
            return;
        }

        _submitting = true;
        clearError();
        setLoading(true);

        try {
            const verifyFn = httpsCallable(getFn(), 'verifySignupOtp');
            const result   = await verifyFn({
                sessionId: session.sessionId,
                otp,
                appType,
            });

            if (result.data?.success) {
                clearSession();

                // Sign the user in with the server-minted custom token so they
                // land on the dashboard with a live Firebase Auth session. Without
                // this the account exists but the browser has no session and the
                // auth guard bounces them to login.
                const customToken = result.data.customToken;
                if (customToken) {
                    try {
                        await signInWithCustomToken(getAuth(getApp()), customToken);
                        showToast('Email verified! Setting up your account...', 'success');
                        setTimeout(() => { window.location.replace(successRedirect); }, 1200);
                        return;   // keep _submitting = true — navigating away
                    } catch (signInErr) {
                        console.error('Custom-token sign-in failed:', signInErr);
                        // Account is created; fall through to manual login.
                    }
                }

                // No token, or sign-in failed → account exists, send to login.
                showToast('Account created! Please sign in to continue.', 'success');
                setTimeout(() => { window.location.replace(_loginRedirect); }, 1400);
                return;
            }

            _submitting = false;
            showError('Verification failed. Please try again.');
            setLoading(false);
            clearOtpInputs();
        } catch (err) {
            _submitting = false;
            setLoading(false);
            const msg = err?.message || 'Verification failed. Please try again.';

            // Check if session is permanently dead (locked / expired)
            if (
                msg.toLowerCase().includes('restart') ||
                msg.toLowerCase().includes('no longer active') ||
                msg.toLowerCase().includes('not found')
            ) {
                clearSession();
                showError(msg + ' Redirecting to signup...');
                setTimeout(() => { window.location.replace(restartRedirect); }, 2500);
                return;
            }

            showError(msg);
            clearOtpInputs();
        }
    }

    wireOtpInputs(submitOtp);

    if (submitBtn) {
        submitBtn.addEventListener('click', submitOtp);
    }

    // ── Resend ────────────────────────────────────────────────────────────────
    startResendCountdown(countdownEl, resendBtn);

    if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
            resendBtn.disabled = true;
            clearError();

            try {
                const resendFn = httpsCallable(getFn(), 'resendSignupOtp');
                await resendFn({
                    sessionId: session.sessionId,
                    email:     session.email,
                    appType,
                });
                showToast('A new code has been sent to your email.', 'success');
                clearOtpInputs();
                // Reset countdown
                if (countdownEl?.parentElement) {
                    countdownEl.parentElement.style.display = '';
                }
                startResendCountdown(countdownEl, resendBtn);
            } catch (err) {
                resendBtn.disabled = false;
                const msg = err?.message || 'Failed to resend code. Please try again.';
                if (
                    msg.toLowerCase().includes('restart') ||
                    msg.toLowerCase().includes('no longer active')
                ) {
                    clearSession();
                    showError(msg + ' Redirecting to signup...');
                    setTimeout(() => { window.location.replace(restartRedirect); }, 2500);
                    return;
                }
                showError(msg);
            }
        });
    }

    // ── Restart signup — wire both nav back button and bottom restart button ──
    const restartLinks = [
        document.getElementById('otp-restart-link'),
        document.getElementById('otp-restart-link-2'),
    ].filter(Boolean);

    restartLinks.forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            clearSession();
            window.location.replace(restartRedirect);
        });
    });
}
