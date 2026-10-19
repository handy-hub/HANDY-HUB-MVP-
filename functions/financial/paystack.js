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

// Ghana MoMo → Paystack **charge** provider codes.
//
// NOT the same values as PROVIDER_BANK_CODES above: those are payout bank codes
// for /transferrecipient, these are the `mobile_money.provider` codes the
// /charge endpoint expects. Telecel is still 'vod' on Paystack's side (the
// network rebranded from Vodafone; the API code did not follow).
const PROVIDER_CHARGE_CODES = {
    mtn:        'mtn',
    telecel:    'vod',
    airteltigo: 'atl',
};

function secretKey() {
    const k = process.env.PAYSTACK_SECRET_KEY;
    if (!k) throw new Error('PAYSTACK_SECRET_KEY environment variable is not set.');
    return k;
}

// ── Failure classification ────────────────────────────────────────────────────
//
// For money-moving calls the question after an error is not "did it fail?" but
// "do we KNOW Paystack did not act?". Every thrown error carries `err.outcome`:
//
//   'rejected' — Paystack answered with a well-formed refusal to a malformed or
//                unauthorised request (HTTP 400/401/403/404/422, JSON status
//                false). The request was not processed. Safe to treat as "no
//                transfer exists".
//   'unknown'  — anything else: network error, timeout, 5xx, a gateway HTML
//                page, a 408/409/429, or a refusal that says the reference is a
//                DUPLICATE (meaning a transfer with it already exists). Paystack
//                may have acted. The caller must not assume either way.
//
// VERIFY against current Paystack docs: the 4xx-means-not-processed rule and the
// wording of duplicate-reference errors.
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);
const DUPLICATE_RE = /duplicate|already\s+(exists|been|initiated|used)/i;
const DEFAULT_TIMEOUT_MS = 20_000;

async function apiRequest(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${secretKey()}`,
            'Content-Type':  'application/json',
        },
        signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);

    let res, json;
    try {
        res = await fetch(`${PAYSTACK_BASE}${path}`, opts);
        json = await res.json();
    } catch (cause) {
        // Never reached Paystack, never heard back, or the reply was not JSON.
        const err = new Error(cause.name === 'AbortError'
            ? `Paystack ${method} ${path} timed out after ${timeoutMs} ms`
            : `Paystack ${method} ${path} unreachable: ${cause.message}`);
        err.outcome    = 'unknown';
        err.httpStatus = res ? res.status : null;
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!json || !json.status) {
        const message = (json && json.message) || `Paystack ${method} ${path} failed`;
        const err = new Error(message);
        err.paystackCode = json && json.code;
        err.httpStatus   = res.status;
        err.outcome = DEFINITIVE_REJECTION_STATUSES.has(res.status) && !DUPLICATE_RE.test(message)
            ? 'rejected'
            : 'unknown';
        throw err;
    }
    return json.data;
}

/** Verify a charge by its Paystack reference. Returns the full charge object. */
async function verifyCharge(reference) {
    return apiRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/**
 * Initialize a Paystack transaction (server-side checkout creation).
 *
 * This is the authoritative replacement for the client-side popup: the AMOUNT
 * and the REFERENCE are decided here, on the server, and can never be chosen or
 * altered by the browser. The client only receives an access code / URL with
 * which to complete payment.
 *
 * @param {object}  p
 * @param {string}  p.email          Customer email (Paystack requires one).
 * @param {number}  p.amountPesewas  Integer minor units. NOT floating GHS.
 * @param {string}  p.reference      Server-generated unique reference.
 * @param {object} [p.metadata]      Reconciliation metadata (never secrets).
 * @param {string[]} [p.channels]    Restrict payment channels, e.g. ['mobile_money'].
 * @returns {Promise<{authorization_url: string, access_code: string, reference: string}>}
 */
async function initializeTransaction({ email, amountPesewas, reference, metadata, channels }) {
    if (!Number.isSafeInteger(amountPesewas) || amountPesewas <= 0) {
        throw new Error('initializeTransaction: amountPesewas must be a positive integer.');
    }
    return apiRequest('POST', '/transaction/initialize', {
        email,
        amount:    amountPesewas,      // Paystack expects minor units (pesewas)
        currency:  'GHS',
        reference,
        ...(metadata ? { metadata } : {}),
        ...(channels && channels.length ? { channels } : {}),
    });
}

/**
 * Charge a Ghanaian Mobile Money wallet DIRECTLY — no Paystack checkout UI.
 *
 * This is the replacement for initializeTransaction() in the top-up flow. Rather
 * than handing the browser a checkout URL, we tell Paystack to push an
 * authorization request straight to the customer's handset. The customer
 * approves it with their MoMo PIN on their own phone; our app renders the whole
 * journey itself.
 *
 * The returned `status` drives the UI and is NOT a payment confirmation:
 *   'pay_offline' — approval prompt sent to the handset; wait.
 *   'send_otp'    — the network wants an OTP; collect it and call submitChargeOtp.
 *   'pending'     — accepted, still settling; wait.
 *   'success'     — Paystack believes it is done. STILL not authoritative here:
 *                   only the signature-verified webhook credits the wallet.
 *   'failed'      — declined.
 *
 * @param {object} p
 * @param {string} p.email          Customer email (Paystack requires one).
 * @param {number} p.amountPesewas  Positive integer, minor units.
 * @param {string} p.reference      Server-generated unique reference.
 * @param {string} p.phone          Subscriber number, e.g. '0551234567'.
 * @param {string} p.provider       'mtn' | 'telecel' | 'airteltigo'.
 * @param {object} [p.metadata]     Reconciliation metadata (never secrets).
 * @returns {Promise<object>} Paystack charge object (status, reference, display_text…)
 */
async function chargeMobileMoney({ email, amountPesewas, reference, phone, provider, metadata }) {
    if (!Number.isSafeInteger(amountPesewas) || amountPesewas <= 0) {
        throw new Error('chargeMobileMoney: amountPesewas must be a positive integer.');
    }
    const code = PROVIDER_CHARGE_CODES[provider];
    if (!code) throw new Error(`Unsupported MoMo provider: "${provider}".`);

    return apiRequest('POST', '/charge', {
        email,
        amount:       amountPesewas,     // minor units (pesewas)
        currency:     'GHS',
        reference,
        mobile_money: { phone, provider: code },
        metadata,
    });
}

/**
 * Submit the OTP for a charge that came back as 'send_otp'.
 * Returns the updated charge object (same status vocabulary as above).
 */
async function submitChargeOtp({ reference, otp }) {
    return apiRequest('POST', '/charge/submit_otp', { reference, otp });
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

/**
 * Look a transfer up by OUR reference — the only identifier we always have,
 * including when initiation timed out and no transfer_code ever came back.
 *
 * Returns the transfer object, or null when Paystack says no transfer with this
 * reference exists. Throws (err.outcome 'unknown') when it cannot tell.
 *
 * VERIFY against current Paystack docs: endpoint GET /transfer/verify/:reference,
 * its not-found response (assumed HTTP 404 / status false), and the `status`
 * values a transfer can take.
 */
async function verifyTransfer(reference) {
    try {
        return await apiRequest('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
    } catch (err) {
        if (err.httpStatus === 404 && !DUPLICATE_RE.test(err.message)) return null;
        err.outcome = 'unknown';
        throw err;
    }
}

module.exports = {
    PROVIDER_BANK_CODES,
    PROVIDER_CHARGE_CODES,
    PROVIDER_NAMES,
    COMMISSION_RATE,
    MIN_WITHDRAWAL,
    verifyCharge,
    initializeTransaction,
    chargeMobileMoney,
    submitChargeOtp,
    createTransferRecipient,
    initiateTransfer,
    getTransfer,
    verifyTransfer,
};
