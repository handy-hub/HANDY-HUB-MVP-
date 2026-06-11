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
    return expected === signature;
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

            // Customer topped up their wallet via Paystack
            case 'charge.success': {
                const userId   = data.metadata?.userId;
                const userType = data.metadata?.userType || 'customer';

                if (!userId) {
                    console.warn('[webhook] charge.success without userId in metadata:', data.reference);
                    break;
                }

                if (userType === 'customer') {
                    // ── Re-verify the charge against Paystack API ────────────────────────
                    // Never trust the webhook payload amount alone. Re-verify to get the
                    // authoritative amount from Paystack's servers.
                    const verifiedCharge = await verifyCharge(data.reference);
                    if (verifiedCharge.status !== 'success') {
                        console.warn(`[webhook] Charge ${data.reference} not successful on Paystack (status: ${verifiedCharge.status}) — skipping credit.`);
                        break;
                    }
                    const verifiedAmount = verifiedCharge.amount / 100; // pesewas → GHS

                    await creditWalletFromCharge({
                        uid:         userId,
                        amountGHS:   verifiedAmount,
                        paystackRef: data.reference,
                        provider:    data.metadata?.provider || null,
                        phone:       data.metadata?.phone    || null,
                        email:       data.customer?.email    || null,
                    });
                    console.log(`[webhook] Wallet credited: ${userId} +GHS ${verifiedAmount}`);
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

module.exports = { handlePaystackWebhook };
