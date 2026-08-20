'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Paystack Webhook handler.
// Verifies the HMAC-SHA512 signature, then dispatches each event type.
// The HTTP endpoint is registered in functions/index.js as an onRequest function.
// ─────────────────────────────────────────────────────────────────────────────

const crypto    = require('crypto');
const { creditWalletFromCharge }                  = require('./wallets');
const { onTransferSuccess, onTransferFailed }     = require('./transfers');
const { verifyCharge }                            = require('./paystack');
const { sendNotification }                        = require('../notifications');
const { MIN_TOPUP_GHS, FIRESTORE_DB_ID }          = require('../config');

// ── Firestore lazy singleton ──────────────────────────────────────────────────
let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

/** Read the server-written top-up intent for a Paystack reference. */
function getTopupIntent(reference) {
    return db().collection('topupIntents').doc(reference).get();
}

/**
 * Move a pending intent to a terminal non-credited state.
 *
 * Guarded by a transaction that refuses to touch an intent which is already
 * 'successful' — out-of-order Paystack deliveries (a late charge.failed after a
 * charge.success) must never be able to mark a credited top-up as failed.
 * Missing intents are a no-op: legacy popup charges have no record.
 */
async function settleIntent(reference, status, reason) {
    const ref = db().collection('topupIntents').doc(reference);
    try {
        await db().runTransaction(async (txn) => {
            const snap = await txn.get(ref);
            if (!snap.exists) return;
            const cur = snap.data().status;
            if (cur === 'successful' || snap.data().credited === true) return;
            if (cur === status) return;
            txn.set(ref, {
                status,
                failureReason: String(reason || '').slice(0, 300),
                updatedAt:     new Date().toISOString(),
            }, { merge: true });
        });
    } catch (err) {
        console.error(`[webhook] settleIntent(${reference}, ${status}) failed: ${err.message}`);
    }
}

/**
 * Verify the x-paystack-signature header against the raw request body.
 * Paystack signs with HMAC-SHA512 using your secret key.
 */
function verifySignature(rawBody, signature) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw new Error('PAYSTACK_SECRET_KEY not configured.');
    const expected = crypto
        .createHmac('sha512', secret)
        .update(rawBody)
        .digest('hex');

    // CX-5: constant-time comparison. A plain `expected === signature` short-circuits
    // on the first differing byte, leaking (in principle) how much of a forged
    // signature was correct. timingSafeEqual requires equal-length buffers, so the
    // length check must happen first — and it must not itself be the secret-dependent
    // branch, which it isn't (HMAC-SHA512 hex is always 128 chars).
    const a = Buffer.from(String(expected), 'utf8');
    const b = Buffer.from(String(signature || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * settleTopupByReference — THE single place a Paystack charge becomes money.
 *
 * Both confirmation paths converge here so they can never diverge in behaviour:
 *   • the Paystack webhook (authoritative asynchronous reconciliation), and
 *   • verifyTopupNow, the client-triggered pull used to confirm in seconds
 *     instead of waiting for the webhook.
 *
 * The client can only ever ask us to LOOK at a reference. Everything that
 * decides whether money moves — the charge status, the currency, the amount, the
 * owner — is read from Paystack's API and from our own intent record. Nothing
 * here trusts a caller's claim that a payment succeeded.
 *
 * Idempotent by construction: the actual credit runs inside
 * creditWalletFromCharge's transactional lock on the reference, so any number of
 * concurrent or repeated calls, in any order, credit exactly once.
 *
 * @param {string} reference          Paystack transaction reference.
 * @param {object} [opts]
 * @param {string} [opts.source]      'webhook' | 'verify' — logging only.
 * @param {object} [opts.metadata]    Paystack metadata, for the legacy fallback.
 * @param {object} [opts.customer]    Paystack customer object, for email.
 * @returns {Promise<{outcome: string, uid?: string, amountGHS?: number}>}
 *          outcome ∈ credited | duplicate | pending | failed | no_owner | rejected
 */
async function settleTopupByReference(reference, opts = {}) {
    const { source = 'webhook', metadata = null, customer = null } = opts;
    const t0 = Date.now();

    if (!reference) return { outcome: 'rejected', reason: 'missing reference' };

    // ── Resolve the wallet owner from OUR record, not from metadata ──────────
    // topupIntents/{reference} is written by initiateTopupCharge with the
    // authenticated UID. Paystack metadata is attacker-influenced on the legacy
    // popup path, so it is only ever a fallback — never an override.
    const intentSnap = await getTopupIntent(reference);
    const intent     = intentSnap.exists ? intentSnap.data() : null;

    const userId   = intent ? intent.uid : metadata?.userId;
    const userType = intent ? 'customer' : (metadata?.userType || 'customer');

    if (!userId) {
        console.warn(`[settle:${source}] No resolvable owner — ref=${reference}`);
        return { outcome: 'no_owner' };
    }
    if (userType !== 'customer') return { outcome: 'rejected', reason: 'not a customer charge' };

    if (!intent) {
        console.warn(`[settle:${source}] No topupIntent for ref=${reference} — legacy metadata path.`);
    }

    // Already settled by the other path — cheap exit, no Paystack round-trip.
    if (intent && intent.credited === true) {
        return { outcome: 'duplicate', uid: userId, amountGHS: Number(intent.amountPesewas || 0) / 100 };
    }

    // ── Authoritative check against Paystack's own API ───────────────────────
    const verifiedCharge = await verifyCharge(reference);
    const psStatus = String(verifiedCharge.status || '').toLowerCase();

    if (psStatus !== 'success') {
        // 'ongoing'/'pending' means the customer simply hasn't finished on their
        // handset yet. That is NOT a failure and must not settle the intent —
        // doing so would tell a customer mid-payment that it had failed.
        if (psStatus === 'ongoing' || psStatus === 'pending' || psStatus === 'processing') {
            return { outcome: 'pending', uid: userId };
        }
        console.warn(`[settle:${source}] ref=${reference} status=${psStatus} — not crediting.`);
        await settleIntent(reference, 'failed', `paystack status: ${psStatus}`);
        return { outcome: 'failed', uid: userId, reason: psStatus };
    }

    const verifiedPesewas  = Math.round(Number(verifiedCharge.amount));
    const verifiedAmount   = verifiedPesewas / 100;
    const verifiedCurrency = String(verifiedCharge.currency || 'GHS').toUpperCase();

    // A GHS wallet is never credited from a charge settled in another currency.
    if (verifiedCurrency !== 'GHS') {
        console.error(`[settle:${source}] Currency mismatch ref=${reference}: ${verifiedCurrency} — refusing credit.`);
        await settleIntent(reference, 'failed', `currency mismatch: ${verifiedCurrency}`);
        return { outcome: 'rejected', reason: 'currency mismatch' };
    }

    // The amount must match what WE asked Paystack to charge.
    if (intent && verifiedPesewas !== Number(intent.amountPesewas)) {
        console.error(`[settle:${source}] Amount mismatch ref=${reference}: charged ${verifiedPesewas}p vs intent ${intent.amountPesewas}p — refusing credit.`);
        await settleIntent(reference, 'failed', `amount mismatch: charged ${verifiedPesewas}p vs intent ${intent.amountPesewas}p`);
        return { outcome: 'rejected', reason: 'amount mismatch' };
    }

    if (verifiedAmount < MIN_TOPUP_GHS) {
        console.warn(`[settle:${source}] Below minimum ref=${reference}: GHS ${verifiedAmount}`);
        await settleIntent(reference, 'failed', 'below minimum top-up');
        return { outcome: 'rejected', reason: 'below minimum' };
    }

    const result = await creditWalletFromCharge({
        uid:         userId,
        amountGHS:   verifiedAmount,
        paystackRef: reference,
        provider:    intent?.provider || metadata?.provider || null,
        phone:       intent?.phone    || metadata?.phone    || null,
        email:       intent?.email    || customer?.email    || null,
        hasIntent:   Boolean(intent),
    });

    const ms = Date.now() - t0;
    if (result.duplicate) {
        console.log(`[settle:${source}] Duplicate ignored ref=${reference} uid=${userId} (${ms}ms)`);
        return { outcome: 'duplicate', uid: userId, amountGHS: verifiedAmount };
    }

    // ── Notify — only on the call that actually moved the money ──────────────
    // Placed after the duplicate check so a repeated webhook or a racing
    // verification can never produce a second "wallet credited" notification.
    // Server-side by design: it fires even if the customer closed the app mid
    // payment, and unlike the old client-side call it cannot be forged.
    //
    // Deliberately not awaited into the caller's critical path, and failures are
    // swallowed: a notification that doesn't send must never undo a credit that
    // already happened.
    try {
        await sendNotification(userId, {
            type:    'Payments',
            title:   'Wallet topped up',
            message: `Your wallet has been credited with GHS ${verifiedAmount.toFixed(2)}.`,
            data:    { reference, amountGHS: verifiedAmount, kind: 'topup_credited' },
        });
    } catch (err) {
        console.warn(`[settle:${source}] Notification failed ref=${reference}: ${err.message}`);
    }

    console.log(`[settle:${source}] Wallet credited uid=${userId} +GHS ${verifiedAmount} ref=${reference} (${ms}ms)`);
    return { outcome: 'credited', uid: userId, amountGHS: verifiedAmount };
}

/**
 * Main webhook dispatcher.
 * Call this from the onRequest Cloud Function with the raw Express req/res.
 */
async function handlePaystackWebhook(req, res) {
    // ── 1. Signature verification ────────────────────────────────────────────
    const signature = req.headers['x-paystack-signature'];

    // Firebase Functions v2 preserves the original request bytes in req.rawBody
    // (a Buffer). Using that is critical — re-serialising req.body with
    // JSON.stringify() may reorder keys or alter formatting, breaking the HMAC.
    const rawBody = req.rawBody
        ? req.rawBody.toString('utf8')
        : JSON.stringify(req.body); // fallback for local emulator / tests

    if (!signature || !verifySignature(rawBody, signature)) {
        console.warn('[webhook] Invalid Paystack signature — request rejected.');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    // ── 2. Always respond 200 quickly (Paystack retries on non-2xx) ──────────
    res.status(200).json({ received: true });

    // ── 3. Process event asynchronously ─────────────────────────────────────
    const event = req.body;
    const data  = event.data;

    try {
        switch (event.event) {

            // Customer topped up their wallet via Paystack.
            //
            // All the verification and crediting lives in settleTopupByReference
            // so this path and the client-triggered verifyTopupNow can never
            // drift apart. Whichever arrives first credits; the other sees the
            // idempotency lock and no-ops.
            case 'charge.success': {
                if (!data.reference) {
                    console.warn('[webhook] charge.success without a reference — ignoring.');
                    break;
                }
                await settleTopupByReference(data.reference, {
                    source:   'webhook',
                    metadata: data.metadata || null,
                    customer: data.customer || null,
                });
                break;
            }

            // Charge did not complete — settle the intent so the customer's UI
            // stops waiting. No balance movement of any kind.
            case 'charge.failed': {
                if (data.reference) {
                    await settleIntent(data.reference, 'failed', 'paystack charge.failed');
                    console.log(`[webhook] Charge failed: ${data.reference}`);
                }
                break;
            }

            // Payout succeeded — update status, no balance change needed
            case 'transfer.success':
                await onTransferSuccess(data);
                console.log(`[webhook] Transfer success: ${data.reference}`);
                break;

            // Payout failed or reversed — update status + roll back balance
            case 'transfer.failed':
            case 'transfer.reversed':
                await onTransferFailed(data, event.event);
                console.log(`[webhook] Transfer ${event.event}: ${data.reference}`);
                break;

            default:
                console.log(`[webhook] Unhandled event: ${event.event}`);
        }
    } catch (err) {
        // Log but don't throw — we already sent 200 to Paystack
        console.error(`[webhook] Error handling ${event.event}:`, err.message, err.stack);
    }
}

module.exports = { handlePaystackWebhook, settleTopupByReference };
