const PUBLIC_KEY = 'pk_test_f340db0f1d321dbc3630b124c321e8a6926640ce';
const SDK_URL    = 'https://js.paystack.co/v1/inline.js';

let sdkReady = null;

function loadSdk() {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise((resolve, reject) => {
        if (window.PaystackPop) { resolve(); return; }
        const s   = document.createElement('script');
        s.src     = SDK_URL;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Failed to load Paystack SDK. Check your connection.'));
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
    return 'HH-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

export async function initiatePayment({ email, amount, metadata = {}, onSuccess, onClose }) {
    if (!amount || Number(amount) <= 0) throw new Error('Invalid amount');

    // Paystack requires a valid email — fall back to a placeholder for phone-auth users
    const effectiveEmail = (email && email.includes('@')) ? email : `user-${Date.now()}@handyhub.app`;

    await loadSdk();

    // Paystack v1 inline.js rejects async functions — wrap in plain sync functions
    const handler = window.PaystackPop.setup({
        key:      PUBLIC_KEY,
        email:    effectiveEmail,
        amount:   Math.round(Number(amount) * 100), // pesewas (GHS × 100)
        currency: 'GHS',
        channels: ['mobile_money'],
        ref:      genRef(),
        metadata,
        callback: function(response) { if (onSuccess) onSuccess(response); },
        onClose:  function()          { if (onClose)  onClose();           }
    });
    handler.openIframe();
}
