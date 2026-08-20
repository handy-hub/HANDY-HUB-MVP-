'use strict';

/**
 * functions/topups.js — wallet top-up initiation (the trusted charge entry point).
 *
 * This is the server-side replacement for the retired client-side Paystack popup
 * (customer-app/js/pages/topupPage.js, USE_LEGACY_PAYSTACK_POPUP). The popup let
 * the browser choose the amount, the reference and the metadata.userId that the
 * webhook later credited — three client-controlled inputs on a money path.
 *
 * TRUST MODEL — what the client may and may not decide
 *   The client proposes an amount and supplies the Security PIN. Everything that
 *   money depends on is decided here:
 *     • the authenticated UID comes from the callable context, never the payload;
 *     • the Paystack reference is generated server-side (the client cannot pick
 *       another customer's reference, or reuse one);
 *     • the amount is validated, clamped to [MIN_TOPUP_GHS, MAX_TOPUP_GHS] and
 *       converted to integer pesewas before it ever reaches Paystack;
 *     • the owning UID is written into topupIntents/{reference} so the webhook
 *       resolves the wallet from OUR record rather than from Paystack metadata.
 *
 *   Initiation NEVER credits a wallet. It creates a `pending` intent and returns
 *   a checkout handle. The only thing that credits a wallet is a signature-
 *   verified webhook whose charge re-verifies as successful against Paystack's
 *   own API (functions/financial/webhooks.js → creditWalletFromCharge).
 *
 * PIN
 *   verifySecurityPinForCharge() runs INSIDE this authenticated flow, which is
 *   why PIN verification is deliberately not its own callable — a standalone
 *   verify endpoint would be a brute-force oracle. The raw PIN is never logged,
 *   never persisted, and never sent to Paystack.
 */

const crypto = require('crypto');
const { getFirestore } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');

const { FIRESTORE_DB_ID, MIN_TOPUP_GHS, MAX_TOPUP_GHS } = require('./config');
const { chargeMobileMoney, submitChargeOtp } = require('./financial/paystack');
const { verifySecurityPinForCharge } = require('./securityPin');

// ── Lazy singleton ────────────────────────────────────────────────────────────
let _db;
function db() {
    if (!_db) _db = getFirestore(FIRESTORE_DB_ID);
    return _db;
}

const COL_INTENTS = 'topupIntents';
const COL_IDEMPOTENCY = 'topupIdempotency';

const VALID_PROVIDERS = Object.freeze(['mtn', 'telecel', 'airteltigo']);

/** Accept only the three Ghanaian networks we support. */
function normalizeProviderOrThrow(p) {
    const v = String(p || '').trim().toLowerCase();
    // Tolerate the network's former name so saved accounts keep working.
    const alias = (v === 'vodafone' || v === 'vod') ? 'telecel' : v;
    if (!VALID_PROVIDERS.includes(alias)) {
        throw new HttpsError('invalid-argument', 'Choose MTN, Telecel or AirtelTigo.');
    }
    return alias;
}

/**
 * Normalize a Ghanaian mobile number to local 0XXXXXXXXX form.
 * Accepts 0XXXXXXXXX, 233XXXXXXXXX and +233XXXXXXXXX, plus spaces/dashes.
 * Rejects anything else rather than guessing — a wrong number means the prompt
 * goes to a stranger's handset.
 */
function normalizeGhanaPhoneOrThrow(input) {
    const digits = String(input || '').replace(/[\s()-]/g, '').replace(/^\+/, '');
    let local;
    if (/^0\d{9}$/.test(digits))        local = digits;
    else if (/^233\d{9}$/.test(digits)) local = '0' + digits.slice(3);
    else {
        throw new HttpsError('invalid-argument', 'Enter a valid Ghana mobile number, e.g. 0551234567.');
    }
    return local;
}

/** Payment lifecycle. Only server-side code moves an intent between these. */
const STATUS = Object.freeze({
    PENDING:   'pending',
    SUCCESSFUL:'successful',   // set by the webhook, alongside the wallet credit
    FAILED:    'failed',
    ABANDONED: 'abandoned',
    INIT_FAILED: 'initialization_failed',
});

const nowIso = () => new Date().toISOString();

function cid() {
    return `TOP-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Server-generated Paystack reference.
 *
 * 96 bits of entropy: unguessable, so a customer cannot target another
 * customer's intent, and collision is not a practical concern. Paystack allows
 * [a-zA-Z0-9-._=] — this stays inside that set.
 */
function generateReference() {
    return `HHTP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}

/**
 * Validate a client-proposed amount and convert to integer minor units.
 *
 * All monetary maths downstream uses pesewas (integers) — never floats. A float
 * amount is accepted at the boundary only because JSON has no integer type, and
 * it is rejected unless it lands cleanly on a pesewa.
 *
 * @returns {number} amount in pesewas
 * @throws {HttpsError} invalid-argument / out-of-range
 */
function toPesewasOrThrow(amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw new HttpsError('invalid-argument', 'Enter a valid top-up amount.');
    }
    if (amount <= 0) {
        throw new HttpsError('invalid-argument', 'Top-up amount must be greater than zero.');
    }
    const scaled  = amount * 100;
    const pesewas = Math.round(scaled);
    // Reject sub-pesewa precision (e.g. 10.005) rather than silently rounding
    // someone's money in either direction.
    if (Math.abs(scaled - pesewas) > 1e-6) {
        throw new HttpsError('invalid-argument', 'Amount cannot have more than two decimal places.');
    }
    if (!Number.isSafeInteger(pesewas)) {
        throw new HttpsError('invalid-argument', 'Enter a valid top-up amount.');
    }
    if (pesewas < Math.round(MIN_TOPUP_GHS * 100)) {
        throw new HttpsError('invalid-argument', `Minimum top-up is GHS ${Number(MIN_TOPUP_GHS).toFixed(2)}.`);
    }
    if (pesewas > Math.round(MAX_TOPUP_GHS * 100)) {
        throw new HttpsError('invalid-argument', `Maximum top-up is GHS ${Number(MAX_TOPUP_GHS).toFixed(2)}.`);
    }
    return pesewas;
}

/** Fire-and-forget immutable audit trail. Never blocks the money path. */
function audit(action, uid, detail, correlationId, extra = {}) {
    db().collection('financialAudit').add({
        action,
        userId:   uid,
        userType: 'customer',
        detail:   String(detail || '').slice(0, 300),
        correlationId,
        ...extra,
        createdAt: nowIso(),
    }).catch(() => { /* auditing must never break a charge */ });
}

// ─────────────────────────────────────────────────────────────────────────────
// initiateTopupCharge
//
// Payload: { amount, pin, provider?, phone?, paymentMethodId?, idempotencyKey? }
//   Supply EITHER paymentMethodId (a saved MoMo account) OR provider + phone.
// Returns: { reference, chargeStatus, displayText, provider, phone,
//            amountPesewas, currency }
//
// Does NOT credit anything. Creates a `pending` intent, then pushes an approval
// prompt directly to the customer's handset — no Paystack checkout UI is ever
// shown. The webhook remains the sole authority for wallet crediting.
// ─────────────────────────────────────────────────────────────────────────────
async function initiateTopupCharge(auth, data = {}) {
    const correlationId = cid();
    const uid = auth.uid;
    const {
        amount, pin,
        provider: rawProvider = null,
        phone:    rawPhone    = null,
        paymentMethodId = null,
        idempotencyKey  = null,
    } = data;

    // ── 1. Amount — validated before we do the expensive PIN hash ────────────
    const amountPesewas = toPesewasOrThrow(amount);

    // ── 2. Security PIN — inside the trusted flow, never a standalone oracle.
    // Throws permission-denied / resource-exhausted (lockout) / failed-precondition.
    //
    // Deliberately BEFORE the idempotency lookup: returning an existing intent's
    // access code is itself a privileged action, so it must not be reachable
    // without the PIN. Verifying first costs one scrypt per retry — a price
    // worth paying to keep every path through this function PIN-gated.
    await verifySecurityPinForCharge(uid, pin);

    // ── 3. Idempotency — replay of the same logical request returns the SAME
    // intent rather than opening a second charge. Claimed transactionally so two
    // concurrent taps cannot both win.
    let idemRef = null;
    if (idempotencyKey != null) {
        if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
            throw new HttpsError('invalid-argument', 'Invalid idempotency key.');
        }
        // Namespaced by UID: one customer can never collide with — or probe —
        // another customer's key.
        idemRef = db().collection(COL_IDEMPOTENCY).doc(`${uid}_${idempotencyKey}`);
        const existing = await idemRef.get();
        if (existing.exists) {
            const prior = existing.data();
            const priorSnap = await db().collection(COL_INTENTS).doc(prior.reference).get();
            // Belt and braces: the claim is UID-namespaced, but never hand back
            // an intent that does not belong to the caller.
            if (priorSnap.exists && priorSnap.data().uid !== uid) {
                throw new HttpsError('permission-denied', 'Not your top-up.');
            }
            if (priorSnap.exists && priorSnap.data().status === STATUS.PENDING) {
                console.log(`[topup][${correlationId}] Idempotent replay uid=${uid} ref=${prior.reference}`);
                const d = priorSnap.data();
                return {
                    reference:     prior.reference,
                    chargeStatus:  d.chargeStatus || 'pending',
                    displayText:   d.displayText  || null,
                    provider:      d.provider     || null,
                    phone:         d.phone        || null,
                    amountPesewas: d.amountPesewas,
                    currency:      'GHS',
                    replayed:      true,
                };
            }
            // A settled (or vanished) intent must not be resurrected under the
            // same key — that would let a client re-open a closed charge.
            throw new HttpsError('already-exists', 'This top-up has already been processed.');
        }
    }

    // ── 4. Resolve the customer + email server-side. The client does not get to
    // say who it is, nor which wallet to fill.
    const custSnap = await db().collection('customers').doc(uid).get();
    if (!custSnap.exists) {
        throw new HttpsError('failed-precondition', 'Customer profile not found.');
    }
    const cust  = custSnap.data();
    const email = auth.token?.email || cust.email || `${uid}@handyhub.app`;

    // ── 4b. Resolve the MoMo wallet to debit ────────────────────────────────
    // Direct charge means these are now REQUIRED and functional — they decide
    // which handset gets the approval prompt. Two sources: a saved payment
    // account (looked up under the caller's own UID, so a foreign ID simply
    // does not resolve — no IDOR surface), or values supplied on the request.
    let provider = null;
    let phone    = null;

    if (paymentMethodId) {
        if (typeof paymentMethodId !== 'string' || paymentMethodId.length > 128) {
            throw new HttpsError('invalid-argument', 'Invalid payment method.');
        }
        const accSnap = await db()
            .collection('customers').doc(uid)
            .collection('paymentAccounts').doc(paymentMethodId)
            .get();
        if (accSnap.exists && accSnap.data().deleted !== true) {
            provider = accSnap.data().provider || null;
            phone    = accSnap.data().phone    || null;
        }
        if (!provider || !phone) {
            throw new HttpsError('failed-precondition', 'That mobile money account is no longer available.');
        }
    } else {
        provider = rawProvider;
        phone    = rawPhone;
    }

    provider = normalizeProviderOrThrow(provider);
    phone    = normalizeGhanaPhoneOrThrow(phone);

    // ── 5. Create the pending intent BEFORE calling Paystack, so a charge can
    // never exist upstream without a local record binding it to this UID.
    const reference = generateReference();
    const intentRef = db().collection(COL_INTENTS).doc(reference);
    const n = nowIso();

    await db().runTransaction(async (txn) => {
        // Defensive: a generated reference must never overwrite an existing one.
        const clash = await txn.get(intentRef);
        if (clash.exists) {
            throw new HttpsError('internal', 'Could not start payment. Please try again.');
        }
        txn.set(intentRef, {
            uid,                                  // ← the authority for crediting
            amountPesewas,                        // ← integer minor units
            currency:        'GHS',
            status:          STATUS.PENDING,
            reference,
            provider,
            phone,
            email,
            paymentMethodId: paymentMethodId || null,
            chargeStatus:    null,   // Paystack's charge state — UI only
            displayText:     null,   // the network's own instruction, if any
            credited:        false,
            createdAt:       n,
            updatedAt:       n,
        });
        if (idemRef) {
            txn.set(idemRef, { uid, reference, createdAt: n });
        }
    });

    // ── 6. Push the charge straight to the customer's handset. No checkout UI.
    // The secret key never leaves the server.
    let charge;
    try {
        charge = await chargeMobileMoney({
            email,
            amountPesewas,
            reference,
            phone,
            provider,
            metadata: {
                // Retained for operator reconciliation in the Paystack dashboard.
                // NOT trusted for crediting — topupIntents/{reference} is.
                userId:   uid,
                userType: 'customer',
                provider,
                phone,
                correlationId,
            },
        });
    } catch (err) {
        await intentRef.set({
            status:        STATUS.INIT_FAILED,
            failureReason: String(err.message || 'charge failed').slice(0, 300),
            updatedAt:     nowIso(),
        }, { merge: true });
        // Release the idempotency claim so the customer can genuinely retry.
        if (idemRef) await idemRef.delete().catch(() => {});
        console.error(`[topup][${correlationId}] Paystack charge failed uid=${uid} ref=${reference}: ${err.message}`);
        audit('topup_initialization_failed', uid, err.message, correlationId, { reference, amountPesewas });
        throw new HttpsError('unavailable', 'Unable to start the payment right now. Please try again.');
    }

    // Paystack's charge status drives our UI only. It is NEVER a wallet credit:
    // even 'success' here leaves credited=false until the signed webhook lands.
    const chargeStatus = String(charge?.status || 'pending');
    const displayText  = String(charge?.display_text || '').slice(0, 300) || null;

    await intentRef.set({
        chargeStatus,
        displayText,
        updatedAt: nowIso(),
    }, { merge: true });

    console.log(`[topup][${correlationId}] Charge sent uid=${uid} ref=${reference} pesewas=${amountPesewas} status=${chargeStatus}`);
    audit('topup_initiated', uid, `pending intent for ${amountPesewas} pesewas (${chargeStatus})`, correlationId, { reference, amountPesewas });

    return {
        reference,
        chargeStatus,               // 'pay_offline' | 'send_otp' | 'pending' | 'success' | 'failed'
        displayText,                // network's own instruction, when it sends one
        provider,
        phone,
        amountPesewas,
        currency: 'GHS',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// submitTopupOtp — some networks answer the charge with 'send_otp'.
//
// Payload: { reference, otp }
// Returns: { chargeStatus, displayText }
//
// Credits nothing. Forwards the OTP to Paystack and reports the new charge
// status; the webhook remains the sole authority for the wallet.
// ─────────────────────────────────────────────────────────────────────────────
async function submitTopupOtp(auth, data = {}) {
    const uid = auth.uid;
    const { reference, otp } = data;

    if (typeof reference !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(reference)) {
        throw new HttpsError('invalid-argument', 'Invalid payment reference.');
    }
    if (typeof otp !== 'string' || !/^\d{4,8}$/.test(otp)) {
        throw new HttpsError('invalid-argument', 'Enter the code exactly as your network sent it.');
    }

    // Ownership check — a customer may only advance THEIR OWN charge. Without
    // this, a reference guessed or observed elsewhere could be driven forward.
    const snap = await db().collection(COL_INTENTS).doc(reference).get();
    if (!snap.exists || snap.data().uid !== uid) {
        throw new HttpsError('not-found', 'Payment not found.');
    }
    if (snap.data().credited === true) {
        return { chargeStatus: 'success', displayText: null };
    }

    let result;
    try {
        result = await submitChargeOtp({ reference, otp });
    } catch (err) {
        console.error(`[topup] OTP submit failed uid=${uid} ref=${reference}: ${err.message}`);
        throw new HttpsError('invalid-argument', 'That code was not accepted. Please check and try again.');
    }

    const chargeStatus = String(result?.status || 'pending');
    const displayText  = String(result?.display_text || '').slice(0, 300) || null;

    await db().collection(COL_INTENTS).doc(reference).set({
        chargeStatus, displayText, updatedAt: nowIso(),
    }, { merge: true });

    return { chargeStatus, displayText };
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyTopupNow — the fast confirmation path.
//
// Payload: { reference }
// Returns: { status, credited, chargeStatus, amountPesewas }
//
// WHY THIS EXISTS: Paystack's charge.success webhook for Ghanaian mobile money
// commonly lands 30s–2min after the customer approves on their handset, because
// the telco settles asynchronously. Waiting only for the webhook left customers
// watching a spinner long after their money had left. This lets the app ASK
// Paystack whether the charge succeeded yet, rather than waiting to be told.
//
// It is emphatically NOT "the client says it succeeded". The client supplies a
// reference and nothing else; the server checks ownership, then reads the real
// status from Paystack's API. Crediting runs through the same
// settleTopupByReference the webhook uses, behind the same idempotency lock, so
// whichever path wins the race, the wallet moves exactly once.
// ─────────────────────────────────────────────────────────────────────────────
async function verifyTopupNow(auth, data = {}) {
    const uid = auth.uid;
    const { reference } = data;

    if (typeof reference !== 'string' || !/^[A-Za-z0-9_.\-=]{8,80}$/.test(reference)) {
        throw new HttpsError('invalid-argument', 'Invalid payment reference.');
    }

    // Ownership first: a customer may only ask about THEIR OWN payment. Without
    // this, an observed reference would let anyone probe another user's payment.
    const snap = await db().collection(COL_INTENTS).doc(reference).get();
    if (!snap.exists || snap.data().uid !== uid) {
        throw new HttpsError('not-found', 'Payment not found.');
    }

    const cur = snap.data();

    // Already settled — answer from our own record, no Paystack round-trip.
    if (cur.credited === true || cur.status === STATUS.SUCCESSFUL) {
        return {
            status:        STATUS.SUCCESSFUL,
            credited:      true,
            chargeStatus:  cur.chargeStatus || 'success',
            amountPesewas: cur.amountPesewas,
        };
    }
    if (cur.status === STATUS.FAILED || cur.status === STATUS.ABANDONED || cur.status === STATUS.INIT_FAILED) {
        return { status: cur.status, credited: false, chargeStatus: cur.chargeStatus || null };
    }

    // Pull the authoritative state from Paystack and settle if it succeeded.
    // Lazily required: webhooks.js requires this module's siblings, and a
    // top-level import here would create a cycle.
    const { settleTopupByReference } = require('./financial/webhooks');

    let result;
    try {
        result = await settleTopupByReference(reference, { source: 'verify' });
    } catch (err) {
        // Paystack unreachable or transiently failing. The payment may well have
        // succeeded, so we must NOT report failure — stay pending and let the
        // caller ask again. The webhook remains the backstop regardless.
        console.warn(`[verifyTopupNow] settle failed ref=${reference}: ${err.message}`);
        return { status: STATUS.PENDING, credited: false, chargeStatus: cur.chargeStatus || null, transient: true };
    }

    switch (result.outcome) {
        case 'credited':
        case 'duplicate':
            return { status: STATUS.SUCCESSFUL, credited: true, chargeStatus: 'success', amountPesewas: cur.amountPesewas };
        case 'failed':
        case 'rejected':
            return { status: STATUS.FAILED, credited: false, chargeStatus: result.reason || null };
        default: // 'pending' | 'no_owner'
            return { status: STATUS.PENDING, credited: false, chargeStatus: cur.chargeStatus || null };
    }
}

module.exports = {
    initiateTopupCharge,
    submitTopupOtp,
    verifyTopupNow,
    STATUS,
    COL_INTENTS,
    // exported for tests
    normalizeProviderOrThrow,
    normalizeGhanaPhoneOrThrow,
    toPesewasOrThrow,
    generateReference,
};
