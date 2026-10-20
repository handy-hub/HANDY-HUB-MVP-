'use strict';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HandyHub Firebase Cloud Functions â€” Financial System
//
// Deploy:
//   firebase deploy --only functions
//
// All secrets and env vars live in functions/.env (gitignored).
// Firebase Functions v2 reads this file at deploy time â€” no Blaze plan needed.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const { initializeApp }    = require('firebase-admin/app');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }            = require('firebase-functions/v2/firestore');
const { onSchedule }                   = require('firebase-functions/v2/scheduler');
const { setGlobalOptions }             = require('firebase-functions/v2');
const { FUNCTIONS_REGION, FIRESTORE_DB_ID, BURST_CPU, USER_FACING_SCALE } = require('./config');

// Capacity for every function. Measured 2026-10-19 — see CLAUDE.md §4.
//
// The binding constraint is Cloud Run "Total CPU allocation"
// (run.googleapis.com/cpu_allocation) in europe-west1: 20,000 milli-vCPU, i.e.
// 20 vCPU, counted over every RUNNING instance — idle ones included, and an
// instance lingers ~15 minutes after its last request. The console will not
// raise it for this project yet (its maximum is the current value). Hitting it
// shows as a 503 ("exceeded its quota limit for run.googleapis.com/
// cpu_allocation") on a cold start, and as "Quota exceeded for total allowable
// CPU" on a deploy. The Instances quota (100) is never reached.
//
// Firebase's default is 1 vCPU per instance, which let only ~20 of these 56
// functions be warm at once. So every function defaults to gen1-sized CPU
// (0.17 vCPU at 256MiB, 0.33 at 512MiB), serving one request per instance, and
// two spreads from ./config opt out:
//   BURST_CPU          1 vCPU, 80 concurrent requests — the Paystack webhook and
//                      the booking/artisan triggers, which receive bursts
//   USER_FACING_SCALE  up to 3 small instances — callables people wait on
// Everything else (admin tools, backfills, schedulers) keeps one small instance;
// backfills and migrations must never run in parallel anyway.
//
// With every function warm once this spends ~17.3 of the 20 vCPU, and no
// function can ever hold more than 1 vCPU. tests/functions-capacity.test.cjs
// enforces both: a new function is small unless it is deliberately listed.
setGlobalOptions({ maxInstances: 1, cpu: 'gcf_gen1' });

initializeApp();

// â”€â”€ Financial modules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const escrow            = require('./financial/escrow');
const escrowAutoRelease = require('./financial/escrowAutoRelease');
const transfers         = require('./financial/transfers');
const webhooks          = require('./financial/webhooks');
const { checkRateLimit } = require('./middleware/rateLimiter');

const VALID_PROVIDERS = new Set(['mtn', 'telecel', 'airteltigo']);

// â”€â”€ Artisan verification module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const artisanVerif  = require('./artisanVerification');

// â”€â”€ Dispute resolution module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const disputesModule = require('./disputes');

// â”€â”€ Artisan index module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const artisanIndex = require('./artisanIndex');

// â”€â”€ Booking lifecycle module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const bookingsModule = require('./bookings');

// â”€â”€ Review lifecycle module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const reviewsModule  = require('./reviews');

// â”€â”€ Dispatch engine module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const dispatchModule = require('./dispatch');

// â”€â”€ Quote lifecycle module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const quotesModule = require('./quotes');

// ── Pricing & inspection lifecycle module ────────────────────────────────────
const pricingModule = require('./pricing');

// â”€â”€ AI search module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const aiSearchModule = require('./aiSearch');

// ── Email OTP signup module ──────────────────────────────────────────────────
const emailOtpModule = require('./emailOtp');
// ─────────────────────────────────────────────────────────────────────────────
// PROFILE PHOTOS — orphan-free Cloudinary replacement (begin → upload → commit)
//
// Cloudinary credentials come from functions/.env via ./config, the same way
// PAYSTACK_SECRET_KEY, PIN_PEPPER and RESEND_API_KEY do. These previously used
// defineSecret(), which reads Google Secret Manager — but the values live in
// .env, Secret Manager had no copy, and Firebase rejects the same key existing
// as both an env var and a secret, so the deploy could never succeed. Migrating
// EVERY secret to Secret Manager is a reasonable future step; doing it for one
// function while four others use .env just fragments the pattern.
// ─────────────────────────────────────────────────────────────────────────────
const profilePhotos = require('./profilePhotos');

exports.beginProfilePhotoReplacement = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60 }, async request => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'beginProfilePhotoReplacement');
    return profilePhotos.begin(request.auth, request.data);
});

exports.commitProfilePhotoReplacement = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60 }, async request => {
    _requireAuth(request);
    return profilePhotos.commit(request.auth, request.data);
});

exports.abortProfilePhotoReplacement = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60 }, async request => {
    _requireAuth(request);
    return profilePhotos.abort(request.auth, request.data);
});

exports.retryProfilePhotoCleanup = onSchedule(
    { schedule: 'every 30 minutes', region: FUNCTIONS_REGION, timeoutSeconds: 300 },
    () => profilePhotos.retryCleanup()
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// WEBHOOK  â€”  Paystack â†’ Firebase (public HTTPS endpoint)
// Add this URL to your Paystack dashboard â†’ Settings â†’ API Keys & Webhooks
// URL: https://{FUNCTIONS_REGION}-lamax-4fd82.cloudfunctions.net/paystackWebhook
// e.g. https://europe-west1-lamax-4fd82.cloudfunctions.net/paystackWebhook
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.paystackWebhook = onRequest(
    { region: FUNCTIONS_REGION, ...BURST_CPU, invoker: 'public' },
    (req, res) => webhooks.handlePaystackWebhook(req, res),
);

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY PIN — account-level credential for financial actions
//
// setSecurityPin  (callable — authenticated)
//   First-time creation of the customer's 4-digit Security PIN. The raw PIN is
//   scrypt-hashed (per-user salt + env pepper) into payment_security/{uid},
//   which no client can read; only safe metadata lands on customers/{uid}.
//   PIN *verification* has NO standalone endpoint by design (brute-force
//   oracle) — trusted flows call securityPin.verifySecurityPinForCharge()
//   internally (e.g. the upcoming initiateTopupCharge).
// ─────────────────────────────────────────────────────────────────────────────
const securityPin = require('./securityPin');

exports.setSecurityPin = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 30, memory: '256MiB' },
    async (request) => {
        _requireAuth(request);
        await checkRateLimit(request.auth.uid, 'setSecurityPin');
        try {
            return await securityPin.setSecurityPin(request.auth, request.data || {});
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[setSecurityPin] Unexpected:', err.message);
            throw new HttpsError('internal', 'Unable to set up your PIN right now.');
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// WALLET TOP-UP — trusted charge initiation
//
// initiateTopupCharge (callable — authenticated)
//   Verifies the Security PIN server-side, validates and clamps the amount,
//   generates the Paystack reference itself, records a `pending` intent bound to
//   the authenticated UID, then opens the Paystack charge. It NEVER credits a
//   wallet: only the signature-verified webhook does that, after re-verifying
//   the charge against Paystack's own API.
//
//   scrypt PIN verification is deliberately slow (~100ms+), so this gets a
//   longer timeout and more memory than a plain CRUD callable.
// ─────────────────────────────────────────────────────────────────────────────
const topups = require('./topups');

exports.initiateTopupCharge = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        await checkRateLimit(request.auth.uid, 'initiateTopupCharge');
        try {
            return await topups.initiateTopupCharge(request.auth, request.data || {});
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            // Never leak stack traces, Paystack errors or internals to the client.
            console.error('[initiateTopupCharge] Unexpected:', err.message);
            throw new HttpsError('internal', 'Unable to start your top-up right now.');
        }
    },
);

/**
 * submitTopupOtp (callable — authenticated)
 *   Some Ghanaian networks answer a mobile-money charge with 'send_otp' instead
 *   of prompting the handset directly. This forwards that code to Paystack and
 *   reports the new charge status. It credits nothing — the webhook still owns
 *   the wallet — and it refuses references that do not belong to the caller.
 */
/**
 * verifyTopupNow (callable — authenticated)
 *   Asks Paystack whether a charge has succeeded yet, instead of waiting for the
 *   webhook (which for Ghanaian MoMo commonly lags 30s–2min behind the customer
 *   approving on their handset). Ownership-checked, and it credits through the
 *   same idempotent settleTopupByReference the webhook uses — so the two paths
 *   race safely and the wallet moves exactly once.
 *
 *   Polled by the client while a charge is outstanding, hence the higher rate
 *   limit and small footprint.
 */
exports.verifyTopupNow = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 30, memory: '256MiB' },
    async (request) => {
        _requireAuth(request);
        await checkRateLimit(request.auth.uid, 'verifyTopupNow');
        try {
            return await topups.verifyTopupNow(request.auth, request.data || {});
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[verifyTopupNow] Unexpected:', err.message);
            throw new HttpsError('internal', 'Unable to check that payment right now.');
        }
    },
);

exports.submitTopupOtp = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 30, memory: '256MiB' },
    async (request) => {
        _requireAuth(request);
        await checkRateLimit(request.auth.uid, 'submitTopupOtp');
        try {
            return await topups.submitTopupOtp(request.auth, request.data || {});
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[submitTopupOtp] Unexpected:', err.message);
            throw new HttpsError('internal', 'Unable to confirm that code right now.');
        }
    },
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ESCROW â€” called from the booking flow
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// None of the four callables below can move money on a customer's or an
// artisan's say-so. Escrow is held, released and refunded by trusted server code
// reacting to the booking's state (see AUTHORIZATION MODEL in
// functions/financial/escrow.js). They used to authorise "either party to the
// escrow" with no look at the booking, which let an artisan pay themselves
// before working, a customer refund themselves after the work or mid-dispute,
// and a customer pre-lock their own booking with a token amount so the real
// payment was never taken. The exports stay so a deploy does not have to
// delete live functions; old clients calling them get permission-denied.

/** Map an escrow-module error onto the right callable error code. */
function _escrowCallableError(err) {
    if (/^Unauthorized/.test(err.message || '')) {
        return new HttpsError('permission-denied', err.message);
    }
    return new HttpsError('failed-precondition', err.message);
}

/**
 * holdBookingFunds - RETIRED for every caller.
 *
 * Escrow is held by onBookingStatusChanged (standard track, on acceptance),
 * approveJobQuote (job escrow) and payCalloutFee / payEmergencyCallout (callout),
 * each with the server's own amount. No client calls this. It used to hold any
 * amount the caller named against any bookingId, under the same idempotency lock
 * those trusted paths use.
 */
exports.holdBookingFunds = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    throw new HttpsError(
        'permission-denied',
        'Payment is secured automatically when your booking is accepted or your quote is approved.',
    );
});

/**
 * releaseEscrow - ADMIN repair only.
 *
 * Releases a held JOB escrow whose booking is already 'completed' (the trigger
 * normally does this; this exists for when it failed). Never a callout escrow,
 * never during a dispute (use resolveDispute).
 *   const release = httpsCallable(functions, 'releaseEscrow');
 *   await release({ escrowId });
 */
exports.releaseEscrow = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'releaseEscrow');
    const { escrowId } = request.data || {};
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required.');

    try {
        await escrow.adminReleaseEscrow(request.auth, escrowId);
        return { released: true };
    } catch (err) {
        throw _escrowCallableError(err);
    }
});

/**
 * refundBooking - ADMIN repair only.
 *
 * Refunds a held JOB escrow whose booking is already 'cancelled' (the trigger
 * normally does this). To refund an active booking, cancel it with
 * cancelBookingAsAdmin; to settle a dispute, use resolveDispute.
 *   const refund = httpsCallable(functions, 'refundBooking');
 *   await refund({ escrowId, reason });
 */
exports.refundBooking = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'refundBooking');
    const { escrowId, reason } = request.data || {};
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required.');

    try {
        await escrow.adminRefundEscrow(request.auth, escrowId, reason);
        return { refunded: true };
    } catch (err) {
        throw _escrowCallableError(err);
    }
});

/**
 * raiseDispute - ADMIN only: freeze a held escrow while a dispute is reviewed.
 *
 * Customers and artisans raise a dispute by moving the booking to 'disputed'
 * (firestore.rules); that is what resolveDispute closes.
 *   const dispute = httpsCallable(functions, 'raiseDispute');
 *   await dispute({ escrowId, disputeId });
 */
exports.raiseDispute = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'raiseDispute');
    const { escrowId, disputeId } = request.data || {};
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required.');
    // Checked before anything is read, so a non-admin learns nothing about
    // whether an escrow exists or what state it is in.
    if (!(await escrow.isAdminAuth(request.auth))) {
        throw new HttpsError('permission-denied', 'Only an administrator can freeze escrow.');
    }

    try {
        await escrow.freezeEscrowForDispute(escrowId, {
            disputeId:  disputeId || null,
            raisedBy:   request.auth.uid,
            callerAuth: request.auth,   // admin only - enforced in freezeEscrowForDispute
        });
        return { frozen: true };
    } catch (err) {
        throw _escrowCallableError(err);
    }
});

/**
 * resolveDispute â€” admin closes an open dispute (full refund, release to
 * artisan, or partial split). Server-authoritative: never trust a client-
 * computed wallet balance.
 *
 *   const resolve = httpsCallable(functions, 'resolveDispute');
 *   await resolve({ disputeId, resolution: 'full_refund', notes });
 *   await resolve({ disputeId, resolution: 'partial_refund', notes, customerAmount });
 */
exports.resolveDispute = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await disputesModule.resolveDispute(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// WITHDRAWALS â€” called from customer/artisan wallet pages
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * processWithdrawal - customer withdraws available (non-escrowed) wallet balance.
 *
 * provider/phone select WHICH of the customer's numbers to pay; the server
 * accepts only a number that has funded one of their credited top-ups.
 *
 *   const withdraw = httpsCallable(functions, 'processWithdrawal');
 *   const { data } = await withdraw({ amount, provider, phone, pin, requestId });
 */
exports.processWithdrawal = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'processWithdrawal');
    const { amount, provider, phone, pin, requestId } = request.data || {};
    _validate({ amount, provider, phone, pin, requestId }, ['amount', 'provider', 'phone', 'pin', 'requestId']);
    if (!VALID_PROVIDERS.has(provider)) throw new HttpsError('invalid-argument', 'Invalid payment provider.');
    _validateGhanaPhone(phone);

    try {
        return await transfers.executeCustomerWithdrawal(request.auth.uid, {
            amountGHS: Number(amount), provider, phone,
            pin: String(pin), requestId: String(requestId),
        });
    } catch (err) {
        throw _withdrawalError(err);
    }
});

/**
 * processArtisanWithdrawal - artisan withdraws their completed earnings.
 *
 * The destination is NOT a parameter: money goes only to the payout account
 * on file (artisans/{uid}/private/kyc), which firestore.rules freezes once the
 * artisan is approved. Any provider/phone in the request is ignored.
 *
 *   const withdraw = httpsCallable(functions, 'processArtisanWithdrawal');
 *   const { data } = await withdraw({ amount, pin, requestId });
 *   // data.status: 'processing' | 'success' | 'unknown' (being confirmed) | 'reserved'
 */
exports.processArtisanWithdrawal = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'processArtisanWithdrawal');
    const { amount, pin, requestId } = request.data || {};
    _validate({ amount, pin, requestId }, ['amount', 'pin', 'requestId']);

    try {
        return await transfers.executeArtisanWithdrawal(request.auth.uid, {
            amountGHS: Number(amount), pin: String(pin), requestId: String(requestId),
        });
    } catch (err) {
        throw _withdrawalError(err);
    }
});

/** HttpsError (e.g. from the PIN check) passes through; user errors keep their code. */
function _withdrawalError(err) {
    if (err instanceof HttpsError) return err;
    if (err.userCode) return new HttpsError(err.userCode, err.message);
    console.error('[withdrawal] Unexpected:', err.message);
    return new HttpsError('internal', 'Withdrawal could not be processed right now. Your balance is unchanged unless shown otherwise in your history.');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ARTISAN INDEX â€” keeps artisan_index in sync with artisans collection
//
// syncArtisanIndex fires on every artisans/{artisanId} write.
// artisan_index is the search/dispatch layer â€” never queried by clients.
//
// backfillArtisanIndex â€” one-time admin migration.
// Run once after deploying this version to populate artisan_index for all
// artisans that have lat/lng. New artisans are indexed automatically by
// syncArtisanIndex from this point on.
//
//   const fn = httpsCallable(functions, 'backfillArtisanIndex');
//   const { data } = await fn({});
//   // { processed, skipped, errors, total }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.syncArtisanIndex = artisanIndex.syncArtisanIndex;

exports.backfillArtisanIndex = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        try {
            return await artisanIndex.runBackfill();
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ARTISAN VERIFICATION â€” admin-driven KYC approval workflow
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * approveArtisan â€” admin approves a submitted verification request.
 *   const fn = httpsCallable(functions, 'approveArtisan');
 *   await fn({ artisanId, notes });
 */
exports.approveArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.approveArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * rejectArtisan â€” admin rejects with a mandatory reason.
 *   await fn({ artisanId, reason });
 */
exports.rejectArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.rejectArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * requestMoreInfo â€” request additional documents / info.
 *   await fn({ artisanId, notes });
 */
exports.requestMoreInfo = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.requestMoreInfo(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * suspendArtisan â€” suspend an approved artisan.
 *   await fn({ artisanId, reason });
 */
exports.suspendArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.suspendArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * reinstateArtisan â€” lift a suspension.
 *   await fn({ artisanId, notes });
 */
exports.reinstateArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.reinstateArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * banArtisan â€” permanently ban an artisan (distinct from suspendArtisan).
 *   await fn({ artisanId, reason });
 */
exports.banArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.banArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * unbanArtisan â€” lift a permanent ban.
 *   await fn({ artisanId, notes });
 */
exports.unbanArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.unbanArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * onVerificationSubmitted â€” Firestore trigger fires when a new
 * verification_request document is created. Sends an admin alert and
 * acknowledges receipt to the artisan.
 */
exports.onVerificationSubmitted = onDocumentCreated(
    { document: 'verification_requests/{artisanId}', database: FIRESTORE_DB_ID, region: FUNCTIONS_REGION },
    (event) => artisanVerif.onVerificationSubmitted(event),
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BOOKING LIFECYCLE â€” status-change notifications
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * onBookingStatusChanged â€” fires on any booking document update.
 * Sends notifications to the customer or artisan based on the new status:
 *   pending â†’ accepted    : customer notified
 *   pending â†’ rejected    : customer notified
 *   accepted â†’ in_progress: customer notified
 *   * â†’ completed         : both notified
 *   * â†’ cancelled         : both notified
 */
exports.onBookingStatusChanged  = bookingsModule.onBookingStatusChanged;

/**
 * cancelBookingAsAdmin â€” admin cancels a booking with a required reason.
 * Writes status: 'cancelled' only after validating the current state; the
 * onBookingStatusChanged trigger above then runs the existing, audited
 * refund path for any booking transitioning to 'cancelled'.
 *
 *   const cancel = httpsCallable(functions, 'cancelBookingAsAdmin');
 *   await cancel({ bookingId, reason });
 */
/**
 * respondToJobOffer — an artisan accepts or declines the job they were offered.
 * The ONLY acceptance path (AR-06): an offered artisan reads job_offers/{id},
 * never the booking, and becomes the booking's artisanId here, after the server
 * has checked the offer is theirs, open and unexpired and that they are approved.
 *
 *   await httpsCallable(functions, 'respondToJobOffer')({ bookingId, decision: 'accept' });
 */
/**
 * artisanAccount — the artisan account actions (functions/artisanAccount.js),
 * one deployed function because the region's CPU quota is spent:
 *   { action: 'ensure' }                a signed-in person without a profile
 *                                       becomes an (unapproved) artisan account,
 *                                       exactly once; customers/admins refused
 *   { action: 'requestProfileChange', name?, category?, specialty?, reason }
 *   { action: 'cancelProfileChange' }   an approved artisan's verified-claim change
 *   { action: 'reviewProfileChange', artisanId, decision, notes }   admin only
 */
exports.artisanAccount = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 30 }, async (request) => {
    _requireAuth(request);
    try {
        return await require('./artisanAccount').handleArtisanAccount(request.auth, request.data || {});
    } catch (err) {
        const code = ['customer_account', 'admin_account', 'not_artisan'].includes(err.reason) ? 'permission-denied'
                   : ['no_email', 'invalid', 'no_change'].includes(err.reason) ? 'invalid-argument'
                   : /Unauthorized|Authentication required/.test(err.message) ? 'permission-denied'
                   : 'failed-precondition';
        throw new HttpsError(code, err.message, err.reason ? { reason: err.reason } : undefined);
    }
});

exports.respondToJobOffer = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 30 }, async (request) => {
    _requireAuth(request);
    try {
        return await require('./jobOffers').respondToJobOffer(request.auth, request.data);
    } catch (err) {
        const code = err.reason === 'invalid' ? 'invalid-argument'
                   : err.reason === 'not_offered' ? 'permission-denied'
                   : 'failed-precondition';
        throw new HttpsError(code, err.message, err.reason ? { reason: err.reason } : undefined);
    }
});

exports.cancelBookingAsAdmin = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await bookingsModule.cancelBookingAsAdmin(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// REVIEW LIFECYCLE â€” atomic artisan rating update on new customer review
//
// onBookingReviewed
//   Fires when a customer writes their `rating` to a completed booking doc.
//   Uses a Firestore transaction to atomically update the artisan's rolling
//   average rating and reviewCount. Eliminates the client-side TOCTOU in the
//   deprecated artisanRepository.applyNewReview().
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.onBookingReviewed = reviewsModule.onBookingReviewed;

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW CORRECTION (admin)
//
// `rating`/`ratingProcessed` are server-only and onBookingReviewed refuses to
// re-aggregate, so there was previously no supported way to remove a review
// after it was written — a real dispute could only be settled by hand-editing
// production. These are that path. Both recompute the artisan aggregate from the
// surviving reviews rather than subtracting, and every reversal is audited.
// ─────────────────────────────────────────────────────────────────────────────
const reviewAdmin = require('./reviewAdmin');

/** Remove one review and recompute the artisan's rating.  await fn({ bookingId, reason }); */
exports.reverseReview = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120 }, async (request) => {
    _requireAuth(request);
    try {
        return await reviewAdmin.reverseReview(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/** Repair a drifted aggregate without removing a review.  await fn({ artisanId }); */
exports.recomputeArtisanAggregate = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120 }, async (request) => {
    _requireAuth(request);
    try {
        return await reviewAdmin.recomputeArtisanAggregate(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DISPATCH ENGINE â€” Uber/Bolt-style sequential artisan matching
//
// onBookingCreated       : fires when booking doc is created â†’ first dispatch round
// checkExpiredDispatches : scheduled every 1 min â†’ re-dispatches timed-out rounds
//
// Rejection + acceptance handling was previously a second onDocumentUpdated
// trigger (onBookingDispatchEvent). It is now called from within
// onBookingStatusChanged (bookings.js) so there is only one trigger per update.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.onBookingCreated        = dispatchModule.onBookingCreated;
exports.checkExpiredDispatches  = dispatchModule.checkExpiredDispatches;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// QUOTE LIFECYCLE â€” artisan submits quote, customer approves/rejects
//
// submitJobQuote  (artisan callable)
//   Artisan sends labour cost + optional materials list.
//   System calculates total and notifies customer.
//
// approveJobQuote  (customer callable)
//   Customer approves the quote â†’ escrow holds full amount â†’ artisan notified.
//
// rejectJobQuote  (customer callable)
//   Customer rejects â†’ artisan notified, can resubmit revised quote.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.submitJobQuote = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.submitJobQuote(request.auth, request.data);
    } catch (err) {
        // invalid_quote: an amount failed shared/js/domain/quoteMoney.js — the
        // fields say which, so the composer can point at them (AR-08).
        if (err.reason === 'invalid_quote') {
            throw new HttpsError('invalid-argument', err.message, { reason: err.reason, fields: err.fields || [] });
        }
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.approveJobQuote = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.approveJobQuote(request.auth, request.data);
    } catch (err) {
        // `reason` lets the app branch without parsing text: insufficient_balance
        // (top up and approve again — nothing moved), escrow_conflict,
        // quote_changed, artisan_unavailable, funding_missing, quote_invalid
        // (a malformed stored quote was withdrawn for correction — AR-08).
        const details = err.reason
            ? { reason: err.reason, needed: err.needed ?? null, available: err.available ?? null }
            : undefined;
        throw new HttpsError('failed-precondition', err.message, details);
    }
});

exports.rejectJobQuote = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.rejectJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRICING & INSPECTION LIFECYCLE — server-authoritative callout fees
//
// getPricingQuote          (customer) additive capped callout fee + quote token
// createInspectionBooking  (customer) booking written server-side from token
// payCalloutFee            (customer) escrows callout → inspection_scheduled
// completeInspection       (artisan)  status-only transition → inspection_done
// cancelInspectionBooking  (either)   fair callout settlement + cancel
// checkBookingTimeouts     (schedule) expires stale quotes/inspections hourly
// adminSeedPricingConfig   (admin)    seeds pricing_config defaults
// ─────────────────────────────────────────────────────────────────────────────

exports.getPricingQuote = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60 }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'getPricingQuote');
    try {
        return await pricingModule.getPricingQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.createInspectionBooking = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120 }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'createInspectionBooking');
    try {
        return await pricingModule.createInspectionBooking(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.payCalloutFee = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'holdBookingFunds');   // shares the financial-hold bucket
    try {
        return await pricingModule.payCalloutFee(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * payEmergencyCallout — escrow the SERVER-COMPUTED emergency callout fee.
 *
 * Takes only a bookingId. There is deliberately no amount parameter: the fee is
 * read from the booking document, which onBookingCreated stamped and
 * firestore.rules forbids clients from writing. Shares the financial-hold rate
 * limit bucket with holdBookingFunds and payCalloutFee.
 */
exports.payEmergencyCallout = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'holdBookingFunds');
    try {
        return await pricingModule.payEmergencyCallout(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.completeInspection = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60 }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'completeInspection');
    try {
        return await pricingModule.completeInspection(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.cancelInspectionBooking = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'cancelInspectionBooking');
    try {
        return await pricingModule.cancelInspectionBooking(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// Payout reconciliation (transfers.reconcilePayouts) rides this hourly job
// rather than adding another deployed function against the Cloud Run instance
// quota. It asks Paystack about every payout still reserved / processing /
// unknown and settles it through the single idempotent finalizePayout path.
// The two jobs are isolated: one failing never stops the other.
exports.checkBookingTimeouts = onSchedule(
    { schedule: 'every 1 hours', region: FUNCTIONS_REGION, timeoutSeconds: 300, memory: '512MiB' },
    async () => {
        const results = await Promise.allSettled([
            pricingModule.checkBookingTimeouts(),
            transfers.reconcilePayouts(),
        ]);
        const [bookingRun, payoutRun] = results;
        if (payoutRun.status === 'fulfilled') console.log('[payouts] reconcile', JSON.stringify(payoutRun.value));
        for (const r of results) {
            if (r.status === 'rejected') console.error('[scheduler] job failed:', r.reason && r.reason.message);
        }
        if (bookingRun.status === 'rejected') throw bookingRun.reason;
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT LIFECYCLE (CX-1)
//
// Account deletion is server-authoritative. The old client-only path
// (reauth → deleteUser) destroyed the Auth identity while leaving wallet funds,
// held escrow, and PII behind, with no cleanup function anywhere — money simply
// became unreachable. These callables refuse deletion while the user has money or
// obligations, then anonymize + delete in a safe order.
// ─────────────────────────────────────────────────────────────────────────────
const accountLifecycle = require('./accountLifecycle');

/** Pre-flight: tell the UI whether deletion is possible, and why not. */
exports.checkAccountDeletable = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60 }, async (request) => {
    _requireAuth(request);
    try {
        return await accountLifecycle.checkAccountDeletable(request.auth);
    } catch (err) {
        throw new HttpsError('internal', err.message);
    }
});

/** Destructive: guarded teardown. Throws failed-precondition with blockers attached. */
exports.requestAccountDeletion = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'requestAccountDeletion');
    try {
        return await accountLifecycle.requestAccountDeletion(request.auth);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message, { blockers: err.blockers || [] });
    }
});

exports.adminSeedPricingConfig = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120 }, async (request) => {
    _requireAuth(request);
    const { ADMIN_EMAILS } = require('./config');
    if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
        throw new HttpsError('permission-denied', 'Super-admin access required.');
    }
    try {
        return await pricingModule.seedPricingConfig();
    } catch (err) {
        throw new HttpsError('internal', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ESCROW LIFECYCLE â€” automated release of expired escrow records
//
// autoReleaseEscrow
//   Scheduled: every 6 hours.
//   Queries escrow where status=='held' AND autoReleaseAt<=now, pages through
//   results in batches of 100, and calls releaseEscrow() or refundEscrow()
//   per document based on the associated booking's status.
//   Safe under repeated execution â€” idempotent by design.
//
// adminBackfillEscrowLocks (callable â€” admin only)
//   One-time migration: creates _escrow_locks documents for all pre-existing
//   "held" escrow records that were created before the C1 lock-document fix.
//   Call once after deploying the new escrow.js. Safe to re-run.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Scheduled escrow auto-release.
 * Runs every 6 hours. Memory 512 MiB. Timeout 540 s.
 *
 * Writes observability docs to:
 *   _auto_release_runs/{runId}         â€” run summary (start, end, counts, status)
 *   _auto_release_failures/{escrowId}  â€” per-escrow failure details for admin review
 */
exports.autoReleaseEscrow = onSchedule(
    {
        schedule:        'every 6 hours',
        region:          FUNCTIONS_REGION,
        timeoutSeconds:  540,
        memory:          '512MiB',
    },
    async () => {
        await escrowAutoRelease.runAutoRelease();
    }
);

/**
 * Admin-callable one-time migration: backfill _escrow_locks for pre-existing escrows.
 * Only super-admins may call this â€” enforced inside backfillEscrowLocks().
 *
 *   const backfill = httpsCallable(functions, 'adminBackfillEscrowLocks');
 *   const { data } = await backfill({});
 *   // data â†’ { processed, skipped, errors }
 */
exports.adminBackfillEscrowLocks = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        // Restrict to super-admins only â€” backfill touches all escrow records.
        const { ADMIN_EMAILS } = require('./config');
        const callerEmail = request.auth.token?.email;
        if (!ADMIN_EMAILS.includes(callerEmail)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        try {
            return await escrow.backfillEscrowLocks();
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

/**
 * backfillSearchKeywords â€” regenerate searchKeywords for all artisan documents.
 *
 * Run once after deploying the updated artisanRepository.js that auto-generates
 * keywords. Artisans registered with the old repository have searchKeywords: []
 * and are invisible in search. This function rebuilds their keyword arrays from
 * their current profile data (name, specialty, category, commonSearchPhrases).
 *
 * Safe to re-run â€” artisans with complete keyword sets are skipped.
 *
 *   const fn = httpsCallable(functions, 'backfillSearchKeywords');
 *   const { data } = await fn({});
 *   // data â†’ { processed, skipped, errors, total }
 */
exports.backfillSearchKeywords = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        const callerEmail = request.auth.token?.email;
        if (!ADMIN_EMAILS.includes(callerEmail)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        try {
            return await artisanVerif.backfillSearchKeywords(request.auth);
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GEOHASH BACKFILL â€” one-time migration for existing artisans
//
// backfillGeohash
//   Iterates all artisan documents that have lat/lng but no geohash field,
//   computes the geohash, and writes it back. Safe to re-run.
//   Call once after deploying this version.
//
//   const fn = httpsCallable(functions, 'backfillGeohash');
//   const { data } = await fn({});
//   // data â†’ { processed, skipped, errors, total }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ARTISAN PRIVATE-DATA MIGRATION - move identity / payout / home-address fields
// off the world-readable artisans/{id} profile into artisans/{id}/private/kyc.
//
// adminMigrateArtisanPrivateData  (super-admin only; safe to re-run)
//   mode 'dry-run' (default) -> report only, writes nothing
//   mode 'copy'              -> fill the private record, never overwriting
//   mode 'strip'             -> copy anything missing, then remove from profile
// Run dry-run, then copy, confirm the admin screens, then strip.
// The report lists artisan ids and FIELD NAMES only - never values.
//
//   const fn = httpsCallable(functions, 'adminMigrateArtisanPrivateData');
//   const { data } = await fn({ mode: 'dry-run' });
const artisanPrivacy = require('./artisanPrivacy');

exports.adminMigrateArtisanPrivateData = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        const mode = (request.data && request.data.mode) || 'dry-run';
        try {
            return await artisanPrivacy.migrateArtisanPrivateData({ mode });
        } catch (err) {
            throw new HttpsError('failed-precondition', err.message);
        }
    },
);

/**
 * adminMigrateContactPrivacy — super-admin only. Moves pre-2026-10-20 artisan
 * precise positions to private/location and booking phone numbers to
 * private/contact (functions/contactPrivacy.js). Defaults to a dry run; run
 * 'copy', check, then 'strip'. Never run automatically.
 */
exports.adminMigrateContactPrivacy = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        const mode = (request.data && request.data.mode) || 'dry-run';
        try {
            return await require('./contactPrivacy').migrateContactPrivacy({ mode });
        } catch (err) {
            throw new HttpsError('failed-precondition', err.message);
        }
    },
);

exports.backfillGeohash = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }

        const { getFirestore } = require('firebase-admin/firestore');
        const { FIRESTORE_DB_ID } = require('./config');
        const db = getFirestore(FIRESTORE_DB_ID);

        // Same encoder as artisanRepository.js â€” no external dep needed in Node
        function geohashForPoint(lat, lng, precision = 6) {
            const B = '0123456789bcdefghjkmnpqrstuvwxyz';
            let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
            let hash = '', bit = 0, even = true, ch = 0;
            while (hash.length < precision) {
                if (even) {
                    const mid = (minLng + maxLng) / 2;
                    if (lng >= mid) { ch = (ch << 1) | 1; minLng = mid; }
                    else            { ch <<= 1;            maxLng = mid; }
                } else {
                    const mid = (minLat + maxLat) / 2;
                    if (lat >= mid) { ch = (ch << 1) | 1; minLat = mid; }
                    else            { ch <<= 1;            maxLat = mid; }
                }
                even = !even;
                if (++bit === 5) { hash += B[ch]; bit = 0; ch = 0; }
            }
            return hash;
        }

        const snap = await db.collection('artisans').get();
        let processed = 0, skipped = 0, errors = 0;

        const BATCH_SIZE = 400;
        let batch = db.batch();
        let batchCount = 0;

        for (const doc of snap.docs) {
            const d = doc.data();
            const lat = d.lat ?? d.latitude ?? null;
            const lng = d.lng ?? d.longitude ?? null;

            if (typeof lat !== 'number' || typeof lng !== 'number') {
                skipped++;
                continue;
            }
            if (d.geohash) {
                skipped++;
                continue;
            }

            try {
                batch.update(doc.ref, { geohash: geohashForPoint(lat, lng) });
                batchCount++;
                processed++;

                if (batchCount >= BATCH_SIZE) {
                    await batch.commit();
                    batch = db.batch();
                    batchCount = 0;
                }
            } catch (e) {
                console.error(`[backfillGeohash] artisan=${doc.id}:`, e.message);
                errors++;
            }
        }

        if (batchCount > 0) await batch.commit();

        console.log(`[backfillGeohash] done â€” processed=${processed} skipped=${skipped} errors=${errors} total=${snap.size}`);
        return { processed, skipped, errors, total: snap.size };
    }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI SEARCH â€” natural-language query interpretation via Claude
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * aiSearch â€” convert a natural-language query to structured artisan search terms.
 *
 *   const fn = httpsCallable(functions, 'aiSearch');
 *   const { data } = await fn({ query: 'my ceiling is leaking' });
 *   // data â†’ { searchTerms: ['plumber', 'ceiling leak'], category: 'plumbing', interpretation: '...' }
 */
exports.aiSearch = onCall({ region: FUNCTIONS_REGION, ...USER_FACING_SCALE }, async (request) => {
    _requireAuth(request);
    const { query } = request.data;
    if (!query || typeof query !== 'string' || !query.trim()) {
        throw new HttpsError('invalid-argument', 'query is required.');
    }
    if (query.trim().length > 200) {
        throw new HttpsError('invalid-argument', 'Query is too long.');
    }
    try {
        return await aiSearchModule.interpretSearchQuery(query.trim());
    } catch (err) {
        console.warn('[aiSearch] interpretation failed:', err.message);
        throw new HttpsError('internal', 'AI search temporarily unavailable.');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL OTP SIGNUP — server-authoritative email verification before account creation
//
// requestSignupOtp  (callable — public, unauthenticated)
//   Validates payload, checks email uniqueness in Firebase Auth, generates
//   a CSPRNG 6-digit OTP, hashes it (SHA-256 + random salt), stores in
//   _email_verifications with 5-minute TTL, and sends the code by email.
//   Returns { sessionId, email, expiresInSeconds, resendCooldownSeconds }.
//
// resendSignupOtp  (callable — public, unauthenticated)
//   Enforces 60-second cooldown + 5 resends/hour per session.
//   Generates a fresh OTP, invalidates the old hash in Firestore, resends.
//
// verifySignupOtp  (callable — public, unauthenticated)
//   Constant-time hash compare, max 5 attempts.
//   On success: atomically creates Firebase Auth user + Firestore profile.
//   Returns { success: true, uid }.
// ─────────────────────────────────────────────────────────────────────────────

exports.requestSignupOtp = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip        = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null;
        const userAgent = request.rawRequest?.headers?.['user-agent'] || null;
        try {
            return await emailOtpModule.requestSignupOtp({
                payload:   request.data.payload,
                appType:   request.data.appType,
                ip,
                userAgent,
            });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[requestSignupOtp]', err.message);
            throw new HttpsError('internal', err.message || 'Failed to initiate verification.');
        }
    }
);

/**
 * signUpArtisanDirect (callable — PUBLIC, pre-auth by nature)
 *   Artisan registration without email verification, used while no verified
 *   sending domain exists. Reuses the same activation routine as the OTP path,
 *   so the resulting profile is identical apart from emailVerified: false.
 *   Rate-limited by IP because it is unauthenticated and creates accounts.
 */
exports.signUpArtisanDirect = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.['x-forwarded-for']
            || 'unknown';
        await checkRateLimit(`ip_${ip}`, 'signUpArtisanDirect');
        try {
            return await emailOtpModule.signUpArtisanDirect({ payload: request.data?.payload });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[signUpArtisanDirect]', err.message);
            throw new HttpsError('internal', 'Could not create your account. Please try again.');
        }
    }
);

exports.resendSignupOtp = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip        = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null;
        const userAgent = request.rawRequest?.headers?.['user-agent'] || null;
        try {
            return await emailOtpModule.resendSignupOtp({
                sessionId: request.data.sessionId,
                email:     request.data.email,
                appType:   request.data.appType,
                ip,
                userAgent,
            });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[resendSignupOtp]', err.message);
            throw new HttpsError('internal', err.message || 'Failed to resend OTP.');
        }
    }
);

exports.verifySignupOtp = onCall(
    { region: FUNCTIONS_REGION, ...USER_FACING_SCALE, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null;
        try {
            return await emailOtpModule.verifySignupOtp({
                sessionId: request.data.sessionId,
                otp:       request.data.otp,
                appType:   request.data.appType,
                ip,
            });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[verifySignupOtp]', err.message);
            throw new HttpsError('internal', err.message || 'Verification failed.');
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _requireAuth(request) {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
}

function _validate(data, required) {
    for (const key of required) {
        if (data[key] === undefined || data[key] === null || data[key] === '') {
            throw new HttpsError('invalid-argument', `"${key}" is required.`);
        }
    }
}

function _validateGhanaPhone(phone) {
    const digits = String(phone).replace(/\D/g, '');
    // Accept: 0XXXXXXXXX (10 digits) or 233XXXXXXXXX (12 digits)
    if (!/^(0\d{9}|233\d{9})$/.test(digits)) {
        throw new HttpsError('invalid-argument', 'Invalid phone number. Must be a valid Ghana mobile number.');
    }
}
