'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Transfers — customer and artisan withdrawals, and everything that settles them.
//
// THE INVARIANTS (each enforced below, each covered by
// tests/payout-integrity.test.cjs)
// ──────────────────────────────────────────────────────────────────────────
//  1. No overspend. The balance is re-read and debited inside one Firestore
//     transaction; concurrent requests serialise on the balance document.
//  2. Step-up. A server-verified Security PIN (functions/securityPin.js, with
//     its escalating lockout) is required before any money moves.
//  3. Bound destination. The client never chooses where money goes:
//       artisan  → the payout account on file (artisans/{uid}/private/kyc),
//                  frozen by firestore.rules once the artisan is approved;
//       customer → only a MoMo number that has funded one of their CREDITED
//                  top-ups (money goes back where it came from).
//  4. One request, one payout. The client sends a requestId; the payout
//     document id is `${uid}_${requestId}`, so a double-tap or a retry returns
//     the payout it already created. The Paystack reference is server-made.
//  5. Settled exactly once. Every state change runs in a transaction that
//     re-reads the payout and is a no-op once it is terminal. A refund is
//     stamped on the payout (refundedAt) in the same transaction that credits
//     the balance, so retries, duplicate webhooks and the reconciler cannot
//     refund twice.
//  6. Unknown is a state, not a failure. When Paystack's answer is ambiguous
//     (timeout, 5xx, duplicate reference, our own write failing after Paystack
//     accepted) the funds stay debited as 'unknown' / 'reserved' and the
//     reconciler asks Paystack what really happened. Money is restored only on
//     a definitive rejection, a confirmed failure/reversal, or a repeated
//     not-found after a grace period.
//
// PAYOUT STATES
//   reserved   balance debited, transfer not yet confirmed initiated
//              (legacy rows say 'pending' — treated identically)
//   processing Paystack accepted the transfer; waiting for the outcome
//   unknown    initiation outcome ambiguous; reconciler must decide
//   success    terminal — money delivered
//   failed     terminal — never sent or failed; balance restored once
//   reversed   terminal — sent then reversed; balance restored once
// ─────────────────────────────────────────────────────────────────────────────

const {
    createTransferRecipient,
    initiateTransfer,
    verifyTransfer,
    PROVIDER_NAMES,
    MIN_WITHDRAWAL,
} = require('./paystack');
const { sendNotification, sendArtisanNotification } = require('../notifications');
const { verifySecurityPinForCharge } = require('../securityPin');

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
const walletIntegrity = require('./walletIntegrity');

const now   = () => new Date().toISOString();
// Use crypto.randomBytes for cryptographically secure transaction references.
// 6 random bytes → 12 hex chars → 16^12 ≈ 281 trillion combinations (collision-free in practice).
const genId = (p) => `${p}-${Date.now()}-${randomBytes(6).toString('hex').toUpperCase()}`;
const fmt   = (n)  => parseFloat(Number(n).toFixed(2));

const STATUS = Object.freeze({
    RESERVED:   'reserved',
    PROCESSING: 'processing',
    UNKNOWN:    'unknown',
    SUCCESS:    'success',
    FAILED:     'failed',
    REVERSED:   'reversed',
});
const OPEN_STATUSES     = ['pending', STATUS.RESERVED, STATUS.PROCESSING, STATUS.UNKNOWN];
const TERMINAL_STATUSES = [STATUS.SUCCESS, STATUS.FAILED, STATUS.REVERSED];
const REFUNDING         = new Set([STATUS.FAILED, STATUS.REVERSED]);

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Reconciliation timing. A payout is only looked at once it has been quiet
// for MIN_AGE (the webhook normally settles it first); a transfer Paystack
// has no record of is refunded only after NOT_FOUND_GRACE and two separate
// not-found observations, so a lookup racing a just-created transfer can't
// trigger a refund.
const RECONCILE = Object.freeze({
    MIN_AGE_MS:        10 * 60_000,
    NOT_FOUND_GRACE_MS: 30 * 60_000,
    NOT_FOUND_CHECKS:  2,
    STALE_ALERT_MS:    24 * 60 * 60_000,
    ERROR_ALERT_AFTER: 3,
    BATCH:             100,
});

/**
 * Paystack transfer status → our state. Anything unrecognised stays OPEN:
 * money is never moved on a status we do not understand.
 * VERIFY against current Paystack docs (transfer status values).
 */
function mapTransferStatus(s) {
    switch (String(s || '').toLowerCase()) {
        case 'success':  return STATUS.SUCCESS;
        case 'failed':   return STATUS.FAILED;
        case 'reversed': return STATUS.REVERSED;
        default:         return null;    // pending, processing, queued, received, otp, ...
    }
}

/** Local 0XXXXXXXXX form, or null. Never throws — used to compare stored numbers. */
function localGhanaPhone(input) {
    const digits = String(input || '').replace(/[\s()-]/g, '').replace(/^\+/, '');
    if (/^0\d{9}$/.test(digits))        return digits;
    if (/^233\d{9}$/.test(digits))      return '0' + digits.slice(3);
    return null;
}

/** A failure the user should see verbatim. */
function userError(code, message) {
    const err = new Error(message);
    err.userCode = code;
    return err;
}

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

// ── Destination: decided by the server, never by the request ──────────────────

async function resolveArtisanDestination(uid) {
    const artisanRef = db().collection('artisans').doc(uid);
    const [pubSnap, privSnap] = await Promise.all([
        artisanRef.get(),
        artisanRef.collection('private').doc('kyc').get(),
    ]);
    if (!pubSnap.exists) throw userError('not-found', 'Artisan account not found.');
    const a = pubSnap.data();
    if (a.status !== 'active' || a.verificationStatus !== 'approved') {
        throw userError('failed-precondition', 'Your account must be verified and active before you can withdraw.');
    }

    const p = privSnap.exists ? privSnap.data() : {};
    // The private record is authoritative. The profile fields are the legacy
    // location, read only until the privacy migration has moved them.
    const acct = p.payoutAccount || a.payoutAccount || {
        provider:    p.momoProvider    || a.momoProvider,
        phone:       p.momoPhone       || a.momoPhone,
        accountName: p.momoAccountName || a.momoAccountName,
    };
    const provider = acct && acct.provider;
    const phone    = localGhanaPhone(acct && acct.phone);
    if (!PROVIDER_NAMES[provider] || !phone) {
        throw userError('failed-precondition',
            'No verified payout account on file. Contact support to add or change your Mobile Money account.');
    }
    return {
        provider, phone,
        accountName: acct.accountName || a.fullName || a.name || null,
    };
}

async function resolveCustomerDestination(uid, { provider, phone }) {
    const custSnap = await db().collection('customers').doc(uid).get();
    if (!custSnap.exists || custSnap.data().deleted) throw userError('not-found', 'Customer account not found.');
    const local = localGhanaPhone(phone);
    if (!PROVIDER_NAMES[provider] || !local) {
        throw userError('invalid-argument', 'Choose one of your saved Mobile Money accounts.');
    }
    // A number proves itself by funding a credited top-up: the customer approved
    // the charge on that handset. Withdrawals may only go back to such a number.
    const intents = await db().collection('topupIntents')
        .where('uid', '==', uid).where('credited', '==', true).limit(200).get();
    const proven = intents.docs.some((d) => {
        const i = d.data();
        return i.provider === provider && localGhanaPhone(i.phone) === local;
    });
    if (!proven) {
        throw userError('failed-precondition',
            'Withdrawals can only go to a Mobile Money number you have topped up from.');
    }
    const c = custSnap.data();
    return { provider, phone: local, accountName: c.name || c.fullName || null };
}

// ── Withdrawal ────────────────────────────────────────────────────────────────

const ACCOUNT = {
    artisan:  { coll: 'artisans',  balance: 'availableBalance', trackWithdrawn: true,  prefix: 'AW',
                reason: 'Fidus X Artisan Earnings',    notify: (...a) => sendArtisanNotification(...a), url: 'wallet.html' },
    customer: { coll: 'customers', balance: 'walletBalance',    trackWithdrawn: false, prefix: 'WD',
                reason: 'Fidus X Wallet Withdrawal',   notify: (...a) => sendNotification(...a),        url: 'transaction-history.html' },
};

/**
 * @param {'artisan'|'customer'} kind
 * @param {string} uid   authenticated caller
 * @param {{ amountGHS:number, pin:string, requestId:string, provider?:string, phone?:string }} opts
 *        provider/phone are a CHOICE among proven numbers for customers and are
 *        ignored for artisans.
 * @returns {{ status, ref, payoutId, transferCode?, duplicate? }}
 */
async function executeWithdrawal(kind, uid, { amountGHS, pin, requestId, provider, phone } = {}) {
    const cfg = ACCOUNT[kind];
    if (!cfg) throw new Error(`Unknown account kind "${kind}".`);

    const amount = fmt(amountGHS);
    if (!Number.isFinite(amount) || amount <= 0) throw userError('invalid-argument', 'Enter a valid amount.');
    if (amount < MIN_WITHDRAWAL) throw userError('invalid-argument', `Minimum withdrawal amount is GHS ${MIN_WITHDRAWAL}.`);
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
        throw userError('invalid-argument', 'Missing request id. Refresh the page and try again.');
    }
    const amountPesewas = Math.round(amount * 100);

    // 2. Step-up — before anything is read or reserved. Throws HttpsError.
    await verifySecurityPinForCharge(uid, pin);

    const firestore  = db();
    const payoutRef  = firestore.collection('payouts').doc(`${uid}_${requestId}`);
    const accountRef = firestore.collection(cfg.coll).doc(uid);

    // 4. Idempotency fast path: this request already produced a payout.
    const existing = await payoutRef.get();
    if (existing.exists) return summarise(existing.id, existing.data(), true);

    // 3. Destination — from the server's records only.
    const dest = kind === 'artisan'
        ? await resolveArtisanDestination(uid)
        : await resolveCustomerDestination(uid, { provider, phone });

    // Recipient creation moves no money; failing here leaves nothing to undo.
    const recipientCode = await getOrCreateRecipient(uid, {
        name: dest.accountName || dest.phone, phone: dest.phone, provider: dest.provider,
    });

    const ref = genId(cfg.prefix);
    const n   = now();

    // 1 + 4. Reserve atomically. Re-checks the idempotency key inside the
    // transaction so two concurrent identical requests produce one payout.
    const reservation = await firestore.runTransaction(async (txn) => {
        const [pSnap, aSnap] = await Promise.all([txn.get(payoutRef), txn.get(accountRef)]);
        if (pSnap.exists) return { duplicate: pSnap.data() };
        if (!aSnap.exists) throw userError('not-found', 'Account not found.');

        const available = fmt(aSnap.data()[cfg.balance] || 0);
        // Only money the verified ledger accounts for may leave the platform
        // (walletIntegrity.js): a balance raised outside the server's money
        // paths must never become a real Mobile Money payout.
        const spend = await walletIntegrity.readSpendable(txn, kind, uid, aSnap.data()[cfg.balance]);
        if (Math.round(amount * 100) > spend.spendableP && amount <= available) {
            throw userError('failed-precondition',
                'Part of your balance could not be matched to your payment history, so it cannot be ' +
                'withdrawn yet. Contact support — your balance is unchanged.');
        }
        if (amount > available) {
            throw userError('failed-precondition', `Insufficient balance. Available: GHS ${available.toFixed(2)}.`);
        }

        const balanceUpdate = { [cfg.balance]: fmt(available - amount), updatedAt: n };
        if (cfg.trackWithdrawn) balanceUpdate.withdrawnTotal = fmt((aSnap.data().withdrawnTotal || 0) + amount);
        txn.set(accountRef, balanceUpdate, { merge: true });

        txn.set(payoutRef, {
            userId:        uid,
            userType:      kind,
            requestId,
            ref,
            amount,
            amountPesewas,
            provider:      dest.provider,
            phone:         dest.phone,
            recipientCode,
            status:        STATUS.RESERVED,
            refundedAt:    null,
            createdAt:     n,
            updatedAt:     n,
        });

        txn.set(accountRef.collection('transactions').doc(`payout_${payoutRef.id}`), {
            type:        'withdrawal',
            amount,
            provider:    dest.provider,
            phone:       dest.phone,
            description: `Withdrawal via ${PROVIDER_NAMES[dest.provider] || dest.provider}`,
            status:      'processing',
            ref,
            payoutId:    payoutRef.id,
            bookingId:   null,
            createdAt:   n,
        });

        txn.set(firestore.collection('financialAudit').doc(), {
            action:        'withdrawal_initiated',
            userId:        uid,
            userType:      kind,
            amount,
            balanceBefore: available,
            balanceAfter:  fmt(available - amount),
            payoutId:      payoutRef.id,
            ref,
            createdAt:     n,
        });
        return { duplicate: null };
    });
    if (reservation.duplicate) return summarise(payoutRef.id, reservation.duplicate, true);

    // Initiate. Three distinct outcomes, three distinct handlings.
    let transfer = null;
    let initErr  = null;
    try {
        transfer = await initiateTransfer({
            amountGHS: amount, recipientCode, reason: cfg.reason, reference: ref,
        });
    } catch (err) {
        initErr = err;
    }

    if (initErr && initErr.outcome === 'rejected') {
        // Paystack refused the request outright: no transfer exists. Restore once.
        await finalizePayout(payoutRef.id, STATUS.FAILED, {
            reason: `rejected at initiation: ${initErr.message}`.slice(0, 300), source: 'initiate',
        });
        throw userError('failed-precondition',
            'Your withdrawal could not be started. Your balance has been restored.');
    }

    if (initErr) {
        // We do not know whether Paystack acted. Keep the money reserved and let
        // the reconciler find out. Telling the user "failed" here — and
        // restoring the balance — is how a payout gets made twice.
        await markOpen(payoutRef.id, STATUS.UNKNOWN, {
            unknownReason: String(initErr.message).slice(0, 300),
        }).catch((e) => console.error(`[transfers] could not mark ${ref} unknown: ${e.message}`));
        await alertOps('initiation_unknown', payoutRef.id, `Initiation outcome unknown for ${ref}: ${initErr.message}`);
        cfg.notify(uid, {
            type: 'Payments', title: 'Withdrawal Processing',
            message: `Your GHS ${amount.toFixed(2)} withdrawal is being confirmed with the payment provider. We'll update you as soon as it settles.`,
            actionUrl: cfg.url, metadata: { ref, payoutId: payoutRef.id },
        }).catch(() => {});
        return { status: STATUS.UNKNOWN, ref, payoutId: payoutRef.id };
    }

    // Paystack accepted it. From here on NOTHING may restore the balance —
    // if our own bookkeeping fails, the payout stays 'reserved' and the
    // reconciler settles it from Paystack's record.
    const mapped = mapTransferStatus(transfer && transfer.status);
    try {
        if (mapped) {
            await finalizePayout(payoutRef.id, mapped, { source: 'initiate', providerStatus: transfer.status });
        } else {
            await markOpen(payoutRef.id, STATUS.PROCESSING, {
                paystackTransferCode: transfer.transfer_code || null,
                providerStatus:       transfer.status || null,
            });
        }
    } catch (e) {
        console.error(`[transfers] Paystack accepted ${ref} but recording it failed: ${e.message}. Reconciler will settle.`);
    }
    if (String(transfer && transfer.status).toLowerCase() === 'otp') {
        await alertOps('transfer_otp', payoutRef.id,
            `Transfer ${ref} is waiting for OTP finalisation. Disable Transfer OTP in the Paystack dashboard for API payouts.`);
    }

    cfg.notify(uid, {
        type: 'Payments', title: 'Withdrawal Initiated',
        message: `GHS ${amount.toFixed(2)} to your ${PROVIDER_NAMES[dest.provider] || dest.provider} account is being processed.`,
        actionUrl: cfg.url, metadata: { ref, payoutId: payoutRef.id },
    }).catch(() => {});

    return { status: mapped || STATUS.PROCESSING, ref, payoutId: payoutRef.id, transferCode: transfer.transfer_code || null };
}

function summarise(payoutId, p, duplicate) {
    return {
        status: p.status === 'pending' ? STATUS.RESERVED : p.status,
        ref: p.ref, payoutId, transferCode: p.paystackTransferCode || null, duplicate,
    };
}

async function executeArtisanWithdrawal(uid, opts) { return executeWithdrawal('artisan', uid, opts); }
async function executeCustomerWithdrawal(uid, opts) { return executeWithdrawal('customer', uid, opts); }

// ── State transitions ─────────────────────────────────────────────────────────

/** Move an OPEN payout to another open state. Never touches a terminal payout. */
async function markOpen(payoutId, status, fields = {}) {
    const ref = db().collection('payouts').doc(payoutId);
    return db().runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists || TERMINAL_STATUSES.includes(snap.data().status)) return false;
        txn.update(ref, { ...fields, status, updatedAt: now() });
        return true;
    });
}

/**
 * The ONE place a payout becomes terminal and the ONE place a withdrawal is
 * refunded. Transactional and idempotent: re-reads the payout, and
 *   • same outcome again            → no-op ('duplicate')
 *   • success → reversed            → allowed, refunds once (the bank returned it)
 *   • any other terminal → other    → refused and raised for a human ('conflict')
 *   • provider amount ≠ our amount  → refused and raised ('amount_mismatch')
 *
 * @returns {Promise<{ result: string }>}
 */
async function finalizePayout(payoutId, outcome, { reason = null, source = 'unknown', providerAmountPesewas = null, providerStatus = null } = {}) {
    if (!TERMINAL_STATUSES.includes(outcome)) throw new Error(`finalizePayout: "${outcome}" is not terminal.`);
    const firestore = db();
    const payoutRef = firestore.collection('payouts').doc(payoutId);

    const pre = await payoutRef.get();
    if (!pre.exists) return { result: 'missing' };
    const { userId, userType, ref } = pre.data();
    const cfg = ACCOUNT[userType];
    if (!cfg) return { result: 'unknown_user_type' };
    const accountRef = firestore.collection(cfg.coll).doc(userId);
    // Ledger row: deterministic for payouts made by this module, looked up by
    // ref for rows written by the previous implementation.
    let ledgerRef = accountRef.collection('transactions').doc(`payout_${payoutId}`);
    const ledgerSnap = await ledgerRef.get();
    if (!ledgerSnap.exists) {
        const q = await accountRef.collection('transactions').where('ref', '==', ref).limit(1).get();
        ledgerRef = q.empty ? null : q.docs[0].ref;
    }

    const result = await firestore.runTransaction(async (txn) => {
        const snap = await txn.get(payoutRef);
        if (!snap.exists) return { result: 'missing' };
        const p = snap.data();
        const n = now();

        if (providerAmountPesewas != null && Number.isFinite(providerAmountPesewas)) {
            const ours = p.amountPesewas != null ? p.amountPesewas : Math.round(Number(p.amount) * 100);
            if (providerAmountPesewas !== ours) return { result: 'amount_mismatch', ours };
        }

        const cur = p.status === 'pending' ? STATUS.RESERVED : p.status;
        if (cur === outcome) return { result: 'duplicate' };

        const isReversalOfSuccess = cur === STATUS.SUCCESS && outcome === STATUS.REVERSED;
        if (TERMINAL_STATUSES.includes(cur) && !isReversalOfSuccess) {
            return { result: 'conflict', from: cur };
        }

        const refund = REFUNDING.has(outcome) && !p.refundedAt;
        const payoutUpdate = {
            status: outcome,
            updatedAt: n,
            settledBy: source,
            ...(providerStatus ? { providerStatus } : {}),
            ...(outcome === STATUS.SUCCESS ? { completedAt: n } : {}),
            ...(REFUNDING.has(outcome) ? { failedAt: n, failureReason: reason } : {}),
            ...(refund ? { refundedAt: n } : {}),
        };
        txn.update(payoutRef, payoutUpdate);

        if (refund) {
            const credit = { [cfg.balance]: FieldValue.increment(Number(p.amount)), updatedAt: n };
            if (cfg.trackWithdrawn) credit.withdrawnTotal = FieldValue.increment(-Number(p.amount));
            txn.update(accountRef, credit);
            txn.set(firestore.collection('financialAudit').doc(), {
                action: 'withdrawal_refunded', userId, userType, amount: p.amount,
                payoutId, ref, outcome, reason, source, createdAt: n,
            });
        } else if (outcome === STATUS.SUCCESS) {
            txn.set(firestore.collection('financialAudit').doc(), {
                action: 'withdrawal_completed', userId, userType, amount: p.amount,
                payoutId, ref, source, createdAt: n,
            });
        }
        if (ledgerRef) {
            txn.update(ledgerRef, { status: outcome === STATUS.SUCCESS ? 'successful' : 'failed', updatedAt: n });
        }
        return { result: refund ? 'refunded' : 'settled', amount: p.amount };
    });

    if (result.result === 'conflict' || result.result === 'amount_mismatch') {
        await alertOps(result.result, payoutId,
            `Payout ${ref}: ${source} reported "${outcome}" ` +
            (result.result === 'conflict' ? `but it is already "${result.from}".` : `for an amount that does not match ours (${result.ours} pesewas).`) +
            ' No money was moved. Investigate in Paystack.');
    } else if (result.result === 'refunded' || result.result === 'settled') {
        const amt = Number(result.amount).toFixed(2);
        const label = PROVIDER_NAMES[pre.data().provider] || pre.data().provider || 'MoMo';
        cfg.notify(userId, outcome === STATUS.SUCCESS
            ? { type: 'Payments', title: 'Withdrawal Successful',
                message: `GHS ${amt} has been sent to your ${label} account successfully.`,
                actionUrl: cfg.url, metadata: { ref, payoutId } }
            : { type: 'Payments', title: 'Withdrawal Failed',
                message: `Your GHS ${amt} withdrawal was ${outcome === STATUS.REVERSED ? 'reversed by the bank' : 'unsuccessful'}. Your balance has been restored.`,
                actionUrl: cfg.url, metadata: { ref, payoutId } },
        ).catch(() => {});
    }
    return result;
}

// ── Webhook entry points ──────────────────────────────────────────────────────

const EVENT_OUTCOME = {
    'transfer.success':  STATUS.SUCCESS,
    'transfer.failed':   STATUS.FAILED,
    'transfer.reversed': STATUS.REVERSED,
};

/**
 * Apply a signature-verified Paystack transfer event. Safe to call any number
 * of times, in any order. Throws only on infrastructure errors, so the webhook
 * can answer non-2xx and let Paystack retry.
 */
async function onTransferEvent(eventType, data = {}) {
    const outcome = EVENT_OUTCOME[eventType];
    if (!outcome || !data.reference) return { result: 'ignored' };
    const q = await db().collection('payouts').where('ref', '==', data.reference).limit(1).get();
    if (q.empty) {
        console.warn(`[transfers] No payout found for ref "${data.reference}".`);
        return { result: 'missing' };
    }
    const amount = Number(data.amount);
    return finalizePayout(q.docs[0].id, outcome, {
        source:   `webhook:${eventType}`,
        reason:   data.reason || data.gateway_response || eventType,
        providerAmountPesewas: Number.isFinite(amount) ? Math.round(amount) : null,
        providerStatus: data.status || null,
    });
}

async function onTransferSuccess(paystackData) { return onTransferEvent('transfer.success', paystackData); }
async function onTransferFailed(paystackData, eventType) {
    return onTransferEvent(eventType === 'transfer.reversed' ? 'transfer.reversed' : 'transfer.failed', paystackData);
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * Ask Paystack what really happened to every payout still open, and settle it.
 * Runs on the hourly scheduler. Idempotent: every settlement goes through
 * finalizePayout, so overlapping runs and racing webhooks cannot double-move.
 */
async function reconcilePayouts({ nowMs = Date.now(), limit = RECONCILE.BATCH } = {}) {
    const stats = { scanned: 0, settled: 0, refunded: 0, stillOpen: 0, notFound: 0, errors: 0, conflicts: 0 };
    const snap = await db().collection('payouts').where('status', 'in', OPEN_STATUSES).limit(limit).get();

    for (const doc of snap.docs) {
        const p = doc.data();
        const createdMs = Date.parse(p.createdAt) || 0;
        const quietMs   = nowMs - (Date.parse(p.updatedAt) || createdMs);
        if (quietMs < RECONCILE.MIN_AGE_MS) continue;
        stats.scanned++;

        let t;
        try {
            t = await verifyTransfer(p.ref);
        } catch (err) {
            stats.errors++;
            const errors = (p.reconcileErrors || 0) + 1;
            await doc.ref.update({ reconcileErrors: errors, lastReconcileError: String(err.message).slice(0, 200), lastReconciledAt: new Date(nowMs).toISOString() }).catch(() => {});
            if (errors >= RECONCILE.ERROR_ALERT_AFTER) {
                await alertOps('reconcile_errors', doc.id, `Payout ${p.ref} could not be checked with Paystack ${errors} times: ${err.message}`);
            }
            continue;
        }

        if (t === null) {
            stats.notFound++;
            if (nowMs - createdMs < RECONCILE.NOT_FOUND_GRACE_MS) continue;
            if (p.status === STATUS.PROCESSING && p.paystackTransferCode) {
                // Paystack gave us a transfer_code and now says it does not
                // exist. That is not "never sent" — it is a contradiction.
                await alertOps('accepted_but_not_found', doc.id,
                    `Payout ${p.ref} was accepted (${p.paystackTransferCode}) but Paystack reports no such transfer. Funds held; investigate.`);
                continue;
            }
            const checks = (p.notFoundCount || 0) + 1;
            if (checks < RECONCILE.NOT_FOUND_CHECKS) {
                await doc.ref.update({ notFoundCount: checks, lastReconciledAt: new Date(nowMs).toISOString() }).catch(() => {});
                continue;
            }
            const r = await finalizePayout(doc.id, STATUS.FAILED, {
                source: 'reconciler', reason: `Paystack has no transfer with this reference after ${checks} checks`,
            });
            if (r.result === 'refunded') stats.refunded++;
            continue;
        }

        const amount = Number(t.amount);
        const mapped = mapTransferStatus(t.status);
        if (mapped) {
            const r = await finalizePayout(doc.id, mapped, {
                source: 'reconciler', reason: t.reason || t.status,
                providerAmountPesewas: Number.isFinite(amount) ? Math.round(amount) : null,
                providerStatus: t.status,
            });
            if (r.result === 'refunded') stats.refunded++;
            else if (r.result === 'settled') stats.settled++;
            else if (r.result === 'conflict' || r.result === 'amount_mismatch') stats.conflicts++;
            continue;
        }

        stats.stillOpen++;
        await markOpen(doc.id, p.status === STATUS.UNKNOWN || p.status === STATUS.RESERVED || p.status === 'pending' ? STATUS.PROCESSING : p.status, {
            providerStatus: t.status || null,
            paystackTransferCode: t.transfer_code || p.paystackTransferCode || null,
            lastReconciledAt: new Date(nowMs).toISOString(),
        }).catch(() => {});
        if (String(t.status).toLowerCase() === 'otp') {
            await alertOps('transfer_otp', doc.id, `Transfer ${p.ref} is waiting for OTP finalisation. Disable Transfer OTP in the Paystack dashboard.`);
        }
        if (nowMs - createdMs > RECONCILE.STALE_ALERT_MS) {
            await alertOps('stale_payout', doc.id, `Payout ${p.ref} has been "${t.status}" at Paystack for over 24 hours.`);
        }
    }
    return stats;
}

// ── Operator alerts ───────────────────────────────────────────────────────────

/**
 * Raise a payout for a human: one admin notification per (payout, kind), plus
 * an immutable audit row. Carries ids and amounts only — no phone numbers.
 */
async function alertOps(kind, payoutId, message) {
    try {
        const firestore = db();
        const ref = firestore.collection('payouts').doc(payoutId);
        const fresh = await firestore.runTransaction(async (txn) => {
            const s = await txn.get(ref);
            if (!s.exists) return false;
            const kinds = s.data().alertedKinds || [];
            if (kinds.includes(kind)) return false;
            txn.update(ref, { alertedKinds: [...kinds, kind], needsAttention: true });
            return true;
        });
        if (!fresh) return;
        const n = now();
        await firestore.collection('admin_notifications').add({
            type: 'payout_attention', kind, payoutId, message, isRead: false, createdAt: n,
        });
        await firestore.collection('financialAudit').add({ action: 'payout_attention', kind, payoutId, message, createdAt: n });
        console.error(`[transfers] ATTENTION ${kind} payout=${payoutId}: ${message}`);
    } catch (err) {
        console.error(`[transfers] alertOps failed (${kind}, ${payoutId}): ${err.message}`);
    }
}

module.exports = {
    STATUS,
    OPEN_STATUSES,   // mirrored by shared/js/domain/walletLedger.js PAYOUT_OPEN_STATUSES (test-checked)
    executeCustomerWithdrawal,
    executeArtisanWithdrawal,
    executeWithdrawal,
    finalizePayout,
    onTransferEvent,
    onTransferSuccess,
    onTransferFailed,
    reconcilePayouts,
    mapTransferStatus,
    localGhanaPhone,
    RECONCILE,
};
