import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { getAuth }                     from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { firebaseApp }                 from '../backend/providers/firebase/firebaseConfig.js';
import { PAYSTACK_CONFIG, PLATFORM_CONFIG, FUNCTIONS_REGION } from '../config/appConfig.js';
import { checkAndRecord, showRateLimitToast } from './rateLimitService.js';

const PUBLIC_KEY = PAYSTACK_CONFIG.publicKey;
const SDK_URL    = PAYSTACK_CONFIG.sdkUrl;

// Lazy-initialised Firebase Functions instance
let _functions = null;
function getFirebaseFunctions() {
    if (!_functions) _functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
    return _functions;
}

let sdkReady = null;

function loadSdk() {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise((resolve, reject) => {
        if (window.PaystackPop) { resolve(); return; }
        const s   = document.createElement('script');
        s.src     = SDK_URL;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Failed to Check your connection.'));
        document.head.appendChild(s);
    });
    return sdkReady;
}

/**
 * Open a Paystack mobile-money payment popup.
 * Returns after the iframe opens; use onSuccess / onClose for completion.
 *
 * @param {string}   opts.email     - Customer email (required by Paystack)
 * @param {number}   opts.amount    - Amount in GHS (converted to pesewas internally)
 * @param {Object}   [opts.metadata]
 * @param {Function} opts.onSuccess - Called with Paystack response object on success
 * @param {Function} [opts.onClose] - Called when user closes popup without paying
 */
function genRef() {
    // Use crypto.getRandomValues for a cryptographically secure reference.
    // 8 random bytes → 16 hex chars → collision probability negligible.
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `HH-${Date.now()}-${hex}`;
}

export async function initiatePayment({ email, amount, metadata = {}, onSuccess, onClose }) {
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) throw new Error('Invalid amount');
    if (amountNum < PLATFORM_CONFIG.minTopupGHS) {
        throw new Error(`Minimum top-up amount is ${PLATFORM_CONFIG.currencySymbol} ${PLATFORM_CONFIG.minTopupGHS}.`);
    }

    // ── Frontend rate limit — max 5 topups per hour per user ──────────────────
    const userId = getAuth(firebaseApp).currentUser?.uid ?? null;
    const rl = checkAndRecord('TOPUP_INITIATION', userId);
    if (!rl.allowed) {
        showRateLimitToast(rl.waitMs, 'payment');
        throw Object.assign(
            new Error(`Topup rate limit exceeded. Wait ${Math.ceil(rl.waitMs / 1000)}s.`),
            { code: 'rate-limited', waitMs: rl.waitMs },
        );
    }

    // Paystack requires a valid email.
    // For phone-auth or social-auth users without an email, use a stable placeholder
    // derived from the user's UID rather than a timestamp (prevents duplicate Paystack
    // customer records on every transaction for the same user).
    // UID-scoped placeholder: each phone/social-auth user gets a unique Paystack
    // customer record. A shared placeholder would merge all such users into one.
    const effectiveEmail = (email && email.includes('@'))
        ? email
        : `noemail+${(userId || 'anon').slice(0, 12)}@handyhub.app`;

    await loadSdk();

    // Paystack v1 inline.js rejects async functions — wrap in plain sync functions
    const handler = window.PaystackPop.setup({
        key:      PUBLIC_KEY,
        email:    effectiveEmail,
        amount:   Math.round(amountNum * 100), // pesewas (GHS × 100)
        currency: 'GHS',
        channels: ['card', 'mobile_money', 'bank'],
        ref:      genRef(),
        metadata,
        callback: function(response) { if (onSuccess) onSuccess(response); },
        onClose:  function()          { if (onClose)  onClose();           }
    });
    handler.openIframe();
}

/**
 * Initiate a wallet withdrawal via the `processWithdrawal` Cloud Function.
 * The function creates a Paystack Transfer Recipient, sends the transfer,
 * and atomically records the transaction + deducts the wallet balance.
 *
 * @param {Object} opts
 * @param {number}  opts.amount   - Amount in GHS
 * @param {string}  opts.provider - 'mtn' | 'telecel' | 'airteltigo'
 * @param {string}  opts.phone    - Mobile money phone number
 * @returns {Promise<{ ref: string, transferCode: string }>}
 */
export async function initiateWithdrawal({ amount, provider, phone }) {
    const processWithdrawal = httpsCallable(getFirebaseFunctions(), 'processWithdrawal');
    const result = await processWithdrawal({ amount, provider, phone });
    return result.data;
}
