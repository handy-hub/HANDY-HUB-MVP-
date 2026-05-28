'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Transfers — customer and artisan withdrawal execution.
// Caches Paystack Transfer Recipients to avoid duplicate API calls.
// On Paystack failure, atomically rolls back the wallet deduction.
// ─────────────────────────────────────────────────────────────────────────────

const {
    createTransferRecipient,
    initiateTransfer,
    PROVIDER_NAMES,
    MIN_WITHDRAWAL,
} = require('./paystack');
const { sendNotification, sendArtisanNotification } = require('../notifications');

const { FIRESTORE_DB_ID }  = require('../config');
const { FieldValue }       = require('firebase-admin/firestore');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const { randomBytes } = require('crypto');

const now   = () => new Date().toISOString();
// Use crypto.randomBytes for cryptographically secure transaction references.
// 6 random bytes → 12 hex chars → 16^12 ≈ 281 trillion combinations (collision-free in practice).
const genId = (p) => `${p}-${Date.now()}-${randomBytes(6).toString('hex').toUpperCase()}`;
const fmt   = (n)  => parseFloat(Number(n).toFixed(2));

// ── Recipient cache ───────────────────────────────────────────────────────────

/**
 * Get or create a Paystack Transfer Recipient, caching the code in Firestore.
 * The cache key is userId_provider_phone so changing numbers creates a fresh recipient.
 */
async function getOrCreateRecipient(userId, { name, phone, provider }) {
    const firestore    = db();
    const cacheKey     = `${userId}_${provider}_${phone.replace(/\s/g, '')}`;
    const recipientRef = firestore.collection('transferRecipients').doc(cacheKey);
    const snap         = await recipientRef.get();

    if (snap.exists && snap.data().recipientCode) {
        return snap.data().recipientCode;
    }

    const recipient = await createTransferRecipient({ name: name || phone, phone, provider });
    const n         = now();

    await recipientRef.set({
        userId,
        provider,
        phone,
        recipientCode: recipient.recipient_code,
        paystackData:  recipient,
        createdAt:     n,
        updatedAt:     n,
    });

    return recipient.recipient_code;
}

// ── Customer withdrawal ───────────────────────────────────────────────────────

/**
 * Withdraw available (non-escrowed) balance for a customer.
 *
 * Flow:
 *   1. Validate inputs & minimum amount
 *   2. Get/create Paystack recipient
 *   3. Atomically deduct balance + create payout + transaction records
 *   4. Initiate Paystack Transfer
 *   5. On failure: roll back Firestore and rethrow
 *
 * @returns {{ ref, payoutId, transferCode }}
 */
async function executeCustomerWithdrawal(uid, { amountGHS, provider, phone, customerName }) {
    const firestore = db();
    const amount    = fmt(amountGHS);

    if (amount < MIN_WITHDRAWAL) {
        throw new Error(`Minimum withdrawal amount is GHS ${MIN_WITHDRAWAL}.`);
    }

    const customerRef = firestore.collection('customers').doc(uid);
    const payoutRef   = firestore.collection('payouts').doc();
    const auditRef    = firestore.collection('financialAudit').doc();
    const ref         = genId('WD');
    const n           = now();

    // Get/create cached Paystack recipient
    const recipientCode = await getOrCreateRecipient(uid, {
        name: customerName || phone,
        phone,
        provider,
    });

    // Atomically deduct balance + create payout record + transaction
    await firestore.runTransaction(async (txn) => {
        const snap = await txn.get(customerRef);
        if (!snap.exists) throw new Error('Customer account not found.');

        const available = fmt(snap.data().walletBalance || 0);
        if (amount > available) {
            throw new Error(`Insufficient balance. Available: GHS ${available}.`);
        }

        // Deduct wallet
        txn.update(customerRef, {
            walletBalance: fmt(available - amount),
            updatedAt:     n,
        });

        // Payout record — updated by webhook on transfer.success/failed
        txn.set(payoutRef, {
            userId:        uid,
            userType:      'customer',
            amount,
            provider,
            phone,
            recipientCode,
            ref,
            status:        'pending',
            retryCount:    0,
            createdAt:     n,
            updatedAt:     n,
        });

        // Customer transaction record
        const txnRef = customerRef.collection('transactions').doc();
        txn.set(txnRef, {
            type:        'withdrawal',
            amount,
            provider,
            phone,
            description: `Withdrawal via ${PROVIDER_NAMES[provider] || provider}`,
            status:      'processing',
            ref,
            payoutId:    payoutRef.id,
            bookingId:   null,
            createdAt:   n,
        });

        // Audit
        txn.set(auditRef, {
            action:        'withdrawal_initiated',
            userId:        uid,
            userType:      'customer',
            amount,
            provider,
            phone,
            balanceBefore: available,
            balanceAfter:  available - amount,
            payoutId:      payoutRef.id,
            ref,
            createdAt:     n,
        });
    });

    // Initiate the actual Paystack transfer
    try {
        const transfer = await initiateTransfer({
            amountGHS:     amount,
            recipientCode,
            reason:        'HandyHub Wallet Withdrawal',
            reference:     ref,
        });

        await payoutRef.update({
            status:               'processing',
            paystackTransferCode: transfer.transfer_code,
            updatedAt:            n,
        });

        // Notify customer: withdrawal is on its way
        sendNotification(uid, {
            type:      'Payments',
            title:     '⏳ Withdrawal Initiated',
            message:   `GHS ${amount.toFixed(2)} to your ${PROVIDER_NAMES[provider] || provider} account is being processed.`,
            actionUrl: 'transaction-history.html',
            metadata:  { ref, payoutId: payoutRef.id },
        }).catch(() => {});

        return { ref, payoutId: payoutRef.id, transferCode: transfer.transfer_code };

    } catch (transferErr) {
        // Transfer failed → roll back atomically with FieldValue.increment.
        // Using a read-then-write here would create a TOCTOU race: if two rollbacks
        // run concurrently they would both read the same (already-deducted) balance
        // and both add `amount` back, effectively crediting the user twice.
        await Promise.all([
            customerRef.update({
                walletBalance: FieldValue.increment(amount),
                updatedAt:     now(),
            }),
            payoutRef.update({
                status:        'failed',
                failureReason: transferErr.message,
                updatedAt:     now(),
            }),
        ]);

        // Notify customer: transfer could not start
        sendNotification(uid, {
            type:      'Payments',
            title:     '❌ Withdrawal Failed',
            message:   `Your GHS ${amount.toFixed(2)} withdrawal could not be initiated. Your balance has been restored.`,
            actionUrl: 'transaction-history.html',
            metadata:  { ref },
        }).catch(() => {});

        throw new Error(`Paystack transfer failed: ${transferErr.message}`);
    }
}

// ── Artisan withdrawal ────────────────────────────────────────────────────────

/**
 * Withdraw completed earnings for an artisan.
 * Only availableBalance can be withdrawn — not pendingBalance or escrowed funds.
 *
 * @returns {{ ref, payoutId, transferCode }}
 */
async function executeArtisanWithdrawal(uid, { amountGHS, provider, phone, artisanName }) {
    const firestore = db();
    const amount    = fmt(amountGHS);

    if (amount < MIN_WITHDRAWAL) {
        throw new Error(`Minimum withdrawal amount is GHS ${MIN_WITHDRAWAL}.`);
    }

    const artisanRef = firestore.collection('artisans').doc(uid);
    const payoutRef  = firestore.collection('payouts').doc();
    const auditRef   = firestore.collection('financialAudit').doc();
    const ref        = genId('AW');
    const n          = now();

    const recipientCode = await getOrCreateRecipient(uid, {
        name: artisanName || phone,
        phone,
        provider,
    });

    await firestore.runTransaction(async (txn) => {
        const snap = await txn.get(artisanRef);
        if (!snap.exists) throw new Error('Artisan account not found.');

        const available  = fmt(snap.data().availableBalance || 0);
        const withdrawn  = fmt(snap.data().withdrawnTotal   || 0);

        if (amount > available) {
            throw new Error(`Insufficient balance. Available: GHS ${available}.`);
        }

        txn.set(artisanRef, {
            availableBalance: fmt(available - amount),
            withdrawnTotal:   fmt(withdrawn + amount),
            updatedAt:        n,
        }, { merge: true });

        txn.set(payoutRef, {
            userId:    uid,
            userType:  'artisan',
            amount,
            provider,
            phone,
            recipientCode,
            ref,
            status:    'pending',
            retryCount: 0,
            createdAt:  n,
            updatedAt:  n,
        });

        const txnRef = artisanRef.collection('transactions').doc();
        txn.set(txnRef, {
            type:        'withdrawal',
            amount,
            provider,
            phone,
            description: `Withdrawal via ${PROVIDER_NAMES[provider] || provider}`,
            status:      'processing',
            ref,
            payoutId:    payoutRef.id,
            createdAt:   n,
        });

        txn.set(auditRef, {
            action:        'withdrawal_initiated',
            userId:        uid,
            userType:      'artisan',
            amount,
            balanceBefore: available,
            balanceAfter:  available - amount,
            payoutId:      payoutRef.id,
            ref,
            createdAt:     n,
        });
    });

    try {
        const transfer = await initiateTransfer({
            amountGHS:     amount,
            recipientCode,
            reason:        'HandyHub Artisan Earnings',
            reference:     ref,
        });

        await payoutRef.update({
            status:               'processing',
            paystackTransferCode: transfer.transfer_code,
            updatedAt:            n,
        });

        // Notify artisan: payout is on its way
        sendArtisanNotification(uid, {
            type:      'Payments',
            title:     '⏳ Withdrawal Initiated',
            message:   `GHS ${amount.toFixed(2)} to your ${PROVIDER_NAMES[provider] || provider} account is being processed.`,
            actionUrl: 'wallet.html',
            metadata:  { ref, payoutId: payoutRef.id },
        }).catch(() => {});

        return { ref, payoutId: payoutRef.id, transferCode: transfer.transfer_code };

    } catch (transferErr) {
        // Roll back atomically. FieldValue.increment avoids the TOCTOU read-then-write
        // race that a freshSnap.get() + update() sequence would introduce.
        await Promise.all([
            artisanRef.update({
                availableBalance: FieldValue.increment(amount),
                withdrawnTotal:   FieldValue.increment(-amount),
                updatedAt:        now(),
            }),
            payoutRef.update({
                status:        'failed',
                failureReason: transferErr.message,
                updatedAt:     now(),
            }),
        ]);

        // Notify artisan: transfer could not start, balance restored
        sendArtisanNotification(uid, {
            type:      'Payments',
            title:     '❌ Withdrawal Failed',
            message:   `Your GHS ${amount.toFixed(2)} withdrawal could not be initiated. Your balance has been restored.`,
            actionUrl: 'wallet.html',
            metadata:  { ref },
        }).catch(() => {});

        throw new Error(`Paystack transfer failed: ${transferErr.message}`);
    }
}

// ── Post-transfer webhook handlers ────────────────────────────────────────────

/**
 * Called by the webhook when a transfer succeeds.
 * Updates payout + transaction status.
 */
async function onTransferSuccess(paystackData) {
    await _updateTransferOutcome(paystackData.reference, 'success', null);
}

/**
 * Called by the webhook when a transfer fails.
 * Updates status AND rolls back the wallet balance.
 */
async function onTransferFailed(paystackData, eventType) {
    await _updateTransferOutcome(
        paystackData.reference,
        eventType === 'transfer.reversed' ? 'reversed' : 'failed',
        paystackData.reason || 'Transfer failed',
    );
}

async function _updateTransferOutcome(ref, newStatus, failureReason) {
    const firestore  = db();
    const n          = now();

    const payoutQuery = await firestore
        .collection('payouts')
        .where('ref', '==', ref)
        .limit(1)
        .get();

    if (payoutQuery.empty) {
        console.warn(`[transfers] No payout found for ref "${ref}".`);
        return;
    }

    const payoutDoc = payoutQuery.docs[0];
    const payout    = payoutDoc.data();

    // ── Idempotency guard ─────────────────────────────────────────────────────
    // Paystack may replay webhooks. If we already processed this outcome, skip
    // silently — otherwise a second transfer.failed event would roll back the
    // wallet a second time, crediting the user twice.
    const TERMINAL_STATUSES = ['success', 'failed', 'reversed'];
    if (TERMINAL_STATUSES.includes(payout.status)) {
        console.log(
            `[transfers] Payout "${payoutDoc.id}" already "${payout.status}" — ` +
            `skipping duplicate ${newStatus} webhook for ref "${ref}".`
        );
        return;
    }

    // Update payout status
    const payoutUpdate = { status: newStatus, updatedAt: n };
    if (newStatus === 'success') payoutUpdate.completedAt = n;
    if (failureReason)           payoutUpdate.failureReason = failureReason;
    await payoutDoc.ref.update(payoutUpdate);

    // Update the matching transaction record
    const collName = payout.userType === 'artisan' ? 'artisans' : 'customers';
    const txnQuery = await firestore
        .collection(collName).doc(payout.userId)
        .collection('transactions')
        .where('ref', '==', ref)
        .limit(1)
        .get();

    if (!txnQuery.empty) {
        const txnStatus = newStatus === 'success' ? 'successful' : 'failed';
        await txnQuery.docs[0].ref.update({ status: txnStatus, updatedAt: n });
    }

    const providerLabel = PROVIDER_NAMES[payout.provider] || payout.provider || 'MoMo';

    // On success: notify user
    if (newStatus === 'success') {
        const notifFn = payout.userType === 'artisan' ? sendArtisanNotification : sendNotification;
        const url     = payout.userType === 'artisan' ? 'wallet.html' : 'transaction-history.html';
        notifFn(payout.userId, {
            type:      'Payments',
            title:     '✅ Withdrawal Successful',
            message:   `GHS ${payout.amount.toFixed(2)} has been sent to your ${providerLabel} account successfully.`,
            actionUrl: url,
            metadata:  { ref, payoutId: payoutDoc.id },
        }).catch(() => {});
    }

    // On failure: roll back the wallet atomically with FieldValue.increment.
    // The idempotency guard above ensures this block runs at most once per payout.
    if (newStatus === 'failed' || newStatus === 'reversed') {
        const balField = payout.userType === 'artisan' ? 'availableBalance' : 'walletBalance';
        const userRef  = firestore.collection(collName).doc(payout.userId);

        // FieldValue.increment avoids a TOCTOU read-then-write race that would
        // occur if we did: get() → read current balance → add back amount → set().
        const rollbackUpdate = {
            [balField]: FieldValue.increment(payout.amount),
            updatedAt:  n,
        };

        // For artisans, also reverse the withdrawnTotal atomically.
        if (payout.userType === 'artisan') {
            rollbackUpdate.withdrawnTotal = FieldValue.increment(-payout.amount);
        }

        await userRef.update(rollbackUpdate);
        console.log(`[transfers] Rolled back GHS ${payout.amount} to ${payout.userType} ${payout.userId} (${newStatus}).`);

        // Notify user of rollback
        const notifFn = payout.userType === 'artisan' ? sendArtisanNotification : sendNotification;
        const url     = payout.userType === 'artisan' ? 'wallet.html' : 'transaction-history.html';
        const statusLabel = newStatus === 'reversed' ? 'reversed by the bank' : 'unsuccessful';
        notifFn(payout.userId, {
            type:      'Payments',
            title:     '❌ Withdrawal Failed',
            message:   `Your GHS ${payout.amount.toFixed(2)} withdrawal was ${statusLabel}. Your balance has been restored.`,
            actionUrl: url,
            metadata:  { ref, payoutId: payoutDoc.id },
        }).catch(() => {});
    }
}

module.exports = {
    executeCustomerWithdrawal,
    executeArtisanWithdrawal,
    onTransferSuccess,
    onTransferFailed,
};
