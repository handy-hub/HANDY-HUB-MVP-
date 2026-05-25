'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Paystack API helper — server-side only, never exposed to the browser.
// Secret key is read from process.env.PAYSTACK_SECRET_KEY (set via Firebase
// Functions secret manager: firebase functions:secrets:set PAYSTACK_SECRET_KEY)
// ─────────────────────────────────────────────────────────────────────────────

const { PAYSTACK_BASE, COMMISSION_RATE, MIN_WITHDRAWAL } = require('../config');

// Ghana MoMo → Paystack bank codes.
// Verify current codes: GET /bank?currency=GHS&type=mobile_money
const PROVIDER_BANK_CODES = {
    mtn:        'MTN',
    telecel:    'VOD',
    airteltigo: 'ATL',
};

const PROVIDER_NAMES = {
    mtn:        'MTN Mobile Money',
    telecel:    'Telecel Cash',
    airteltigo: 'AirtelTigo Money',
};

function secretKey() {
    const k = process.env.PAYSTACK_SECRET_KEY;
    if (!k) throw new Error('PAYSTACK_SECRET_KEY environment variable is not set.');
    return k;
}

async function apiRequest(method, path, body) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${secretKey()}`,
            'Content-Type':  'application/json',
        },
    };
    if (body) opts.body = JSON.stringify(body);

    const res  = await fetch(`${PAYSTACK_BASE}${path}`, opts);
    const json = await res.json();

    if (!json.status) {
        const err = new Error(json.message || `Paystack ${method} ${path} failed`);
        err.paystackCode = json.code;
        throw err;
    }
    return json.data;
}

/** Verify a charge by its Paystack reference. Returns the full charge object. */
async function verifyCharge(reference) {
    return apiRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Create (or look up) a Paystack Transfer Recipient for mobile money.
 * Returns the full recipient object (including recipient_code).
 */
async function createTransferRecipient({ name, phone, provider }) {
    const bank_code = PROVIDER_BANK_CODES[provider];
    if (!bank_code) throw new Error(`Unsupported MoMo provider: "${provider}".`);

    return apiRequest('POST', '/transferrecipient', {
        type:           'mobile_money',
        name:           name || phone,
        account_number: phone,
        bank_code,
        currency:       'GHS',
    });
}

/**
 * Initiate a Paystack Transfer (payout).
 * amountGHS is in GHS; converted to pesewas (×100) internally.
 */
async function initiateTransfer({ amountGHS, recipientCode, reason, reference }) {
    return apiRequest('POST', '/transfer', {
        source:    'balance',
        amount:    Math.round(amountGHS * 100),
        recipient: recipientCode,
        reason:    reason || 'HandyHub Payout',
        currency:  'GHS',
        ...(reference ? { reference } : {}),
    });
}

/** Fetch a transfer status by transfer_code. */
async function getTransfer(transferCode) {
    return apiRequest('GET', `/transfer/${transferCode}`);
}

module.exports = {
    PROVIDER_BANK_CODES,
    PROVIDER_NAMES,
    COMMISSION_RATE,
    MIN_WITHDRAWAL,
    verifyCharge,
    createTransferRecipient,
    initiateTransfer,
    getTransfer,
};
