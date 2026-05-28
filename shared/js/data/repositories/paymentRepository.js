const CUSTOMERS   = 'customers';
const ACCOUNTS    = 'paymentAccounts';
const TRANSACTIONS = 'transactions';

function now() { return new Date().toISOString(); }

/**
 * Generate a cryptographically random reference string.
 * Uses the Web Crypto API (available in all modern browsers and Node ≥ 15).
 * 4 random bytes → 8 uppercase hex chars → 4 294 967 296 possible values.
 * Replaces the old Math.random() version which had only 90 000 possible values
 * and is not cryptographically secure (CRIT-4 fix).
 */
function genRef(prefix) {
    const arr = new Uint8Array(4);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${prefix}-${Date.now()}-${hex}`;
}

export function createPaymentRepository({ databaseService: db }) {

    // ── Payment Accounts ──────────────────────────────────────────────────────

    async function getAccounts(uid) {
        try {
            const rows = await db.querySubCollection(
                CUSTOMERS, uid, ACCOUNTS, [],
                { orderBy: { field: 'createdAt', direction: 'desc' } }
            );
            return rows.filter(r => !r.data.deleted);
        } catch { return []; }
    }

    async function addAccount(uid, { provider, phone, nickname = '', isDefault = false }) {
        if (isDefault) await _clearDefaults(uid);
        return db.addSubDocument(CUSTOMERS, uid, ACCOUNTS, {
            provider,
            phone:     phone.trim(),
            nickname:  nickname.trim(),
            isDefault: Boolean(isDefault),
            deleted:   false,
            createdAt: now()
        });
    }

    async function deleteAccount(uid, accountId) {
        return db.updateSubDocument(CUSTOMERS, uid, ACCOUNTS, accountId, {
            deleted: true, deletedAt: now()
        });
    }

    async function setDefaultAccount(uid, accountId) {
        await _clearDefaults(uid, accountId);
        return db.updateSubDocument(CUSTOMERS, uid, ACCOUNTS, accountId, { isDefault: true });
    }

    async function _clearDefaults(uid, exceptId = null) {
        const accounts = await getAccounts(uid);
        await Promise.all(
            accounts
                .filter(a => a.data.isDefault && a.id !== exceptId)
                .map(a => db.updateSubDocument(CUSTOMERS, uid, ACCOUNTS, a.id, { isDefault: false }))
        );
    }

    /** Returns unsubscribe fn. onChange receives array of {id, data} (deleted excluded). */
    function subscribeToAccounts(uid, onChange, onError) {
        return db.subscribeToSubCollection(
            CUSTOMERS, uid, ACCOUNTS, [],
            { orderBy: { field: 'createdAt', direction: 'desc' } },
            (records) => onChange(records.filter(r => !r.data.deleted)),
            onError
        );
    }

    // ── Transactions ──────────────────────────────────────────────────────────

    /** Returns unsubscribe fn. onChange receives array of {id, data}, newest first. */
    function subscribeToTransactions(uid, onChange, onError) {
        return db.subscribeToSubCollection(
            CUSTOMERS, uid, TRANSACTIONS, [],
            { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 60 },
            onChange,
            onError
        );
    }

    /**
     * Record a PENDING top-up transaction in the customer's transaction sub-collection.
     *
     * ⚠️  This does NOT update walletBalance — Firestore client rules prohibit it.
     *     The authoritative wallet credit (and status upgrade to 'successful') is
     *     performed server-side by the Paystack webhook → creditWalletFromCharge().
     *
     * Storing paystackRef here lets the webhook detect the pending record and
     * upgrade it in-place rather than creating a duplicate entry.
     *
     * @returns {Promise<string>} new transaction doc ID
     */
    async function recordTopUp(uid, { amount, provider, phone, paystackRef }) {
        const amountNum = Number(amount);
        if (!amountNum || amountNum <= 0) throw new Error('Invalid amount');

        return db.addSubDocument(CUSTOMERS, uid, TRANSACTIONS, {
            type:        'topup',
            amount:      amountNum,
            provider:    provider    || null,
            phone:       phone       || null,
            description: `Wallet Top Up via ${PROVIDER_NAMES[provider] || provider}`,
            status:      'pending',   // webhook upgrades to 'successful' and credits wallet
            ref:         paystackRef || genRef('TP'),
            paystackRef: paystackRef || null,
            bookingId:   null,
            createdAt:   now()
        });
    }

    /**
     * ⛔  REMOVED — recordWithdrawal() was removed because it performed a
     * read-then-write of walletBalance from the frontend without a Firestore
     * transaction (TOCTOU race → potential double-spend).
     *
     * All withdrawals MUST go through the `processWithdrawal` Cloud Function
     * which uses an atomic Firestore transaction and calls the Paystack API
     * server-side.
     *
     * Frontend usage:
     *   import { initiateWithdrawal } from '../services/paystackService.js';
     *   await initiateWithdrawal({ amount, provider, phone });
     */

    return {
        getAccounts,
        addAccount,
        deleteAccount,
        setDefaultAccount,
        subscribeToAccounts,
        subscribeToTransactions,
        recordTopUp,
        // recordWithdrawal intentionally removed — use Cloud Function instead
    };
}

export const PROVIDER_NAMES = {
    mtn:        'MTN Mobile Money',
    telecel:    'Telecel Cash',
    airteltigo: 'AirtelTigo Money'
};

export const PROVIDER_META = {
    mtn: {
        label:  'MTN MoMo',
        color:  '#FFCC00',
        badge:  '#000',
        logo: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                 <circle cx="20" cy="20" r="20" fill="#FFCC00"/>
                 <ellipse cx="20" cy="20.5" rx="11.5" ry="7" fill="none" stroke="#111" stroke-width="2"/>
                 <text x="20" y="24" text-anchor="middle"
                       font-family="Arial,Helvetica,sans-serif"
                       font-size="7.2" font-weight="900" fill="#111">MTN</text>
               </svg>`
    },
    telecel: {
        label:  'Telecel Cash',
        color:  '#E00000',
        badge:  '#fff',
        logo: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                 <circle cx="20" cy="20" r="20" fill="#E00000"/>
                 <text x="21" y="30" text-anchor="middle"
                       font-family="Arial,Helvetica,sans-serif"
                       font-size="24" font-weight="900" fill="#fff">t</text>
               </svg>`
    },
    airteltigo: {
        label:  'AirtelTigo',
        color:  '#003F7F',
        badge:  '#fff',
        logo: `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                 <defs>
                   <clipPath id="atclip"><circle cx="20" cy="20" r="20"/></clipPath>
                 </defs>
                 <rect x="0" y="0"  width="40" height="20" fill="#003F7F" clip-path="url(#atclip)"/>
                 <rect x="0" y="20" width="40" height="20" fill="#E00000" clip-path="url(#atclip)"/>
                 <text x="20" y="27.5" text-anchor="middle"
                       font-family="Arial,Helvetica,sans-serif"
                       font-size="14" font-weight="900" fill="#fff">at</text>
               </svg>`
    }
};
