const CUSTOMERS   = 'customers';
const ACCOUNTS    = 'paymentAccounts';
const TRANSACTIONS = 'transactions';

function now() { return new Date().toISOString(); }

function genRef(prefix) {
    return prefix + '-' + Math.floor(10000 + Math.random() * 90000);
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
     * Record a top-up transaction AND credit the customer's walletBalance.
     * Returns the new transaction doc ID.
     */
    async function recordTopUp(uid, { amount, provider, phone, paystackRef }) {
        const amountNum = Number(amount);
        if (!amountNum || amountNum <= 0) throw new Error('Invalid amount');

        // Credit wallet
        const snap = await db.getDocument(CUSTOMERS, uid);
        const prev = snap.exists ? (Number(snap.data.walletBalance) || 0) : 0;
        await db.updateDocument(CUSTOMERS, uid, { walletBalance: prev + amountNum, updatedAt: now() });

        // Record transaction
        return db.addSubDocument(CUSTOMERS, uid, TRANSACTIONS, {
            type:        'topup',
            amount:      amountNum,
            provider:    provider || null,
            phone:       phone    || null,
            description: `Wallet Top Up via ${PROVIDER_NAMES[provider] || provider}`,
            status:      'successful',
            ref:         paystackRef || genRef('TP'),
            bookingId:   null,
            createdAt:   now()
        });
    }

    /**
     * Deduct from wallet and record a pending withdrawal transaction.
     * Actual payout is fulfilled by a backend process.
     */
    async function recordWithdrawal(uid, { amount, provider, phone }) {
        const amountNum = Number(amount);
        if (!amountNum || amountNum <= 0) throw new Error('Invalid amount');

        const snap    = await db.getDocument(CUSTOMERS, uid);
        const balance = snap.exists ? (Number(snap.data.walletBalance) || 0) : 0;
        if (amountNum > balance) throw new Error('Insufficient wallet balance');

        await db.updateDocument(CUSTOMERS, uid, { walletBalance: balance - amountNum, updatedAt: now() });

        return db.addSubDocument(CUSTOMERS, uid, TRANSACTIONS, {
            type:        'withdrawal',
            amount:      amountNum,
            provider:    provider || null,
            phone:       phone    || null,
            description: `Withdrawal via ${PROVIDER_NAMES[provider] || provider || 'Mobile Money'}`,
            status:      'pending',
            ref:         genRef('WD'),
            bookingId:   null,
            createdAt:   now()
        });
    }

    return {
        getAccounts,
        addAccount,
        deleteAccount,
        setDefaultAccount,
        subscribeToAccounts,
        subscribeToTransactions,
        recordTopUp,
        recordWithdrawal
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
