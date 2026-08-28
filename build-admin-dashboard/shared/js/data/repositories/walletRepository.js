// ─────────────────────────────────────────────────────────────────────────────
// walletRepository — read-only data access for wallet, escrow, and payout info.
// All balance MUTATIONS must go through Cloud Functions (never frontend-direct).
// ─────────────────────────────────────────────────────────────────────────────

const ARTISANS    = 'artisans';
const CUSTOMERS   = 'customers';
const ESCROW      = 'escrow';
const PAYOUTS     = 'payouts';
const COMMISSIONS = 'commissions';
const TRANSACTIONS = 'transactions';

export function createWalletRepository({ databaseService: db }) {

    // ── Customer wallet ───────────────────────────────────────────────────────

    /** Subscribe to real-time wallet snapshot for a customer. */
    function subscribeToCustomerWallet(uid, onChange, onError) {
        return db.subscribeToDocument(CUSTOMERS, uid, (snap) => {
            if (!snap.exists) { onChange(null); return; }
            const d = snap.data;
            onChange({
                available:  parseFloat((Number(d.walletBalance)  || 0).toFixed(2)),
                inEscrow:   parseFloat((Number(d.escrowBalance)  || 0).toFixed(2)),
                total:      parseFloat(((Number(d.walletBalance) || 0) + (Number(d.escrowBalance) || 0)).toFixed(2)),
            });
        }, onError);
    }

    /** Subscribe to real-time transactions for a customer (newest first, limit 60). */
    function subscribeToCustomerTransactions(uid, onChange, onError) {
        return db.subscribeToSubCollection(
            CUSTOMERS, uid, TRANSACTIONS, [],
            { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 60 },
            onChange,
            onError,
        );
    }

    // ── Artisan wallet ────────────────────────────────────────────────────────

    /** Subscribe to real-time wallet snapshot for an artisan. */
    function subscribeToArtisanWallet(uid, onChange, onError) {
        return db.subscribeToDocument(ARTISANS, uid, (snap) => {
            if (!snap.exists) { onChange(null); return; }
            const d = snap.data;
            onChange({
                available:   parseFloat((Number(d.availableBalance) || 0).toFixed(2)),
                pending:     parseFloat((Number(d.pendingBalance)   || 0).toFixed(2)),
                totalEarned: parseFloat((Number(d.totalEarned)      || 0).toFixed(2)),
                withdrawn:   parseFloat((Number(d.withdrawnTotal)   || 0).toFixed(2)),
            });
        }, onError);
    }

    /** Subscribe to real-time transactions for an artisan (newest first, limit 60). */
    function subscribeToArtisanTransactions(uid, onChange, onError) {
        return db.subscribeToSubCollection(
            ARTISANS, uid, TRANSACTIONS, [],
            { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 60 },
            onChange,
            onError,
        );
    }

    // ── Escrow ────────────────────────────────────────────────────────────────

    /** Get a single escrow record by ID. */
    async function getEscrow(escrowId) {
        return db.getDocument(ESCROW, escrowId);
    }

    /** Get all escrow records for a booking. */
    async function getEscrowByBooking(bookingId) {
        return db.queryWithOptions(ESCROW, [
            { field: 'bookingId', op: '==', value: bookingId },
        ], { limit: 10 });
    }

    /** Subscribe to escrow record updates (e.g. status changes). */
    function subscribeToEscrow(escrowId, onChange, onError) {
        return db.subscribeToDocument(ESCROW, escrowId, onChange, onError);
    }

    // ── Payouts ───────────────────────────────────────────────────────────────

    /** Subscribe to payout history for a user (newest first). */
    function subscribeToPayouts(userId, onChange, onError) {
        return db.subscribeToCollection(
            PAYOUTS,
            [{ field: 'userId', op: '==', value: userId }],
            { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 30 },
            onChange,
            onError,
        );
    }

    // ── Admin / platform ──────────────────────────────────────────────────────

    /** Subscribe to platform earnings summary (admin only). */
    function subscribeToPlatformEarnings(onChange, onError) {
        return db.subscribeToDocument('platform', 'earnings', onChange, onError);
    }

    /** Get commissions, optionally filtered by artisan/date range. */
    async function getCommissions({ artisanId, limit: lim = 50 } = {}) {
        const conditions = artisanId
            ? [{ field: 'artisanId', op: '==', value: artisanId }]
            : [];
        return db.queryWithOptions(COMMISSIONS, conditions, {
            orderBy: { field: 'createdAt', direction: 'desc' },
            limit:   lim,
        });
    }

    /** Get all payouts (admin overview), with optional userType filter. */
    async function getAllPayouts({ userType, status, limit: lim = 100 } = {}) {
        const conditions = [];
        if (userType) conditions.push({ field: 'userType', op: '==', value: userType });
        if (status)   conditions.push({ field: 'status',   op: '==', value: status });
        return db.queryWithOptions(PAYOUTS, conditions, {
            orderBy: { field: 'createdAt', direction: 'desc' },
            limit:   lim,
        });
    }

    /** Get all escrow records (admin). */
    async function getAllEscrow({ status, limit: lim = 100 } = {}) {
        const conditions = status ? [{ field: 'status', op: '==', value: status }] : [];
        return db.queryWithOptions(ESCROW, conditions, {
            orderBy: { field: 'createdAt', direction: 'desc' },
            limit:   lim,
        });
    }

    return {
        // Customer
        subscribeToCustomerWallet,
        subscribeToCustomerTransactions,
        // Artisan
        subscribeToArtisanWallet,
        subscribeToArtisanTransactions,
        // Escrow
        getEscrow,
        getEscrowByBooking,
        subscribeToEscrow,
        // Payouts
        subscribeToPayouts,
        // Admin
        subscribeToPlatformEarnings,
        getCommissions,
        getAllPayouts,
        getAllEscrow,
    };
}
