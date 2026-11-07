/**
 * shared/js/domain/artisanEarnings.js — what the artisan's Earnings screen says,
 * and where each figure comes from (Phase 4).
 *
 * Pure: no DOM, no Firebase. No balance is computed here. Every figure is read
 * from, or summed over, records the SERVER writes transactionally:
 *
 *   available to withdraw  artisans/{id}.availableBalance       (walletLedger.deriveArtisanWallet)
 *   held for your jobs     Σ artisanShare of escrow 'held'      (the customer's money until release)
 *   in dispute             Σ artisanShare of escrow 'disputed'
 *   on its way             Σ amount of payouts still open        (the payouts collection decides)
 *   paid out               withdrawnTotal − on its way
 *   earned to date         artisans/{id}.totalEarned
 *   gross · fee · net      Σ totalAmount · commission · amount of the 'earning' rows
 *                          (functions/financial/escrow.js releaseEscrow, disputes.js) —
 *                          the fee the server took, row by row, never re-derived from a rate
 *
 * Reconciliation (walletLedger.reconcileArtisanWallet) compares the stored
 * totals with the ledger rows. It runs only when the WHOLE ledger has been read
 * — a partial ledger proves nothing — and its result is shown, never hidden.
 * The server applies one more check this module cannot: before a withdrawal it
 * accepts only money its verified ledger accounts for (walletIntegrity.js), which
 * needs the customers' ledgers. A refusal there is shown in the server's words.
 */
import { deriveArtisanWallet, reconcileArtisanWallet, withdrawalStatus } from './walletLedger.js';
import { formatGHS } from '../utils/currency.js';

const toP = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const fromP = (p) => p / 100;
const has = (v) => v !== null && v !== undefined && v !== '';

export const PROVIDER_NAMES = Object.freeze({ mtn: 'MTN MoMo', telecel: 'Telecel Cash', vodafone: 'Telecel Cash', airteltigo: 'AirtelTigo Money', at: 'AirtelTigo Money' });

/** "024 ••• 5678" — never the whole number. */
export function maskPhone(p) {
    const d = String(p || '').replace(/\D/g, '');
    return d.length >= 7 ? `${d.slice(0, 3)} ••• ${d.slice(-4)}` : null;
}

/**
 * The fee the server took, from the earning rows themselves.
 * @param {object[]} transactions  artisans/{id}/transactions rows (data + id)
 */
export function earningsSummary(transactions = []) {
    let grossP = 0, feeP = 0, netP = 0, earnings = 0, tipsP = 0, tips = 0;
    const rates = new Set();
    const mismatches = [];
    for (const t of transactions) {
        if (!t) continue;
        if (t.type === 'tip') { tipsP += toP(t.amount); tips++; continue; }
        if (t.type !== 'earning') continue;
        earnings++;
        netP += toP(t.amount);
        feeP += toP(t.commission);
        grossP += has(t.totalAmount) ? toP(t.totalAmount) : toP(t.amount) + toP(t.commission);
        if (Number.isFinite(Number(t.commissionRate)) && has(t.commissionRate)) rates.add(Number(t.commissionRate));
        // gross − fee must be the net on every row; the server rounds the fee to
        // the pesewa at hold time and the share is the remainder (escrow.planHold).
        if (has(t.totalAmount) && toP(t.totalAmount) - toP(t.commission) !== toP(t.amount)) {
            mismatches.push({ id: t.id || null, ref: t.ref || null });
        }
    }
    return {
        earnings, gross: fromP(grossP), fee: fromP(feeP), net: fromP(netP),
        tips, tipsTotal: fromP(tipsP),
        rates: [...rates].sort(),
        feeChanged: rates.size > 1,
        mismatches,
    };
}

const WITHDRAWAL_LABEL = { successful: 'Paid out', failed: 'Failed', processing: 'On its way' };

/** A payout, as the payouts collection records it. */
export function payoutView(p) {
    const s = String(p && p.status || '').toLowerCase();
    const restored = !!(p && p.refundedAt);
    const label = s === 'success'                 ? 'Paid out'
                : s === 'failed'                  ? (restored ? 'Failed · balance restored' : 'Failed')
                : s === 'reversed'                ? (restored ? 'Reversed · balance restored' : 'Reversed')
                : s === 'unknown'                 ? 'Being confirmed with the provider'
                : s === 'processing'              ? 'Processing with the provider'
                : s === 'reserved' || s === 'pending' ? 'Requested'
                :                                   'Status not recorded';
    const tone = s === 'success' ? 'ok' : (s === 'failed' || s === 'reversed') ? 'bad' : s ? 'warn' : '';
    return {
        id: p && p.id || null,
        ref: p && p.ref || null,
        amount: fromP(toP(p && p.amount)),
        provider: PROVIDER_NAMES[String(p && p.provider || '').toLowerCase()] || (p && p.provider) || null,
        phone: maskPhone(p && p.phone),
        status: s || null, label, tone, restored,
        requestedAt: (p && p.createdAt) || null,
        settledAt: (p && (p.completedAt || p.failedAt)) || null,
        open: ['pending', 'reserved', 'processing', 'unknown'].includes(s),
    };
}

/**
 * One ledger row, described from its own fields (and its payout, for a withdrawal).
 * @param {object} t  a transaction row (data + id)
 * @param {{ payoutsById?: Map, bookings?: Map<string, { service?: string }> }} [ctx]
 */
export function ledgerRow(t, ctx = {}) {
    const payoutsById = ctx.payoutsById || new Map();
    const bookings = ctx.bookings || new Map();
    const type = String(t && t.type || '');
    const service = t && t.bookingId && bookings.get(t.bookingId) ? bookings.get(t.bookingId).service : null;
    const base = { id: t && t.id || null, ref: t && t.ref || null, when: (t && t.createdAt) || null,
                   amount: fromP(toP(t && t.amount)), bookingId: (t && t.bookingId) || null };
    if (type === 'earning') {
        return { ...base, kind: 'earning', sign: '+', title: service ? `Job payment · ${service}` : 'Job payment',
                 status: 'Paid to your balance', tone: 'ok',
                 gross: has(t.totalAmount) ? fromP(toP(t.totalAmount)) : null, fee: fromP(toP(t.commission)),
                 rate: Number.isFinite(Number(t.commissionRate)) && has(t.commissionRate) ? Number(t.commissionRate) : null,
                 escrowId: t.escrowId || null };
    }
    if (type === 'tip') {
        return { ...base, kind: 'tip', sign: '+', title: service ? `Tip · ${service}` : 'Tip from a customer',
                 status: 'Paid to your balance', tone: 'ok', gross: null, fee: 0, rate: null };
    }
    if (type === 'withdrawal') {
        const payout = t.payoutId ? payoutsById.get(t.payoutId) : null;
        const pv = payout ? payoutView(payout) : null;
        const st = withdrawalStatus(t, payout);
        const to = [PROVIDER_NAMES[String(t.provider || '').toLowerCase()] || t.provider, maskPhone(t.phone)].filter(Boolean).join(' ');
        return { ...base, kind: 'withdrawal', sign: '−', title: to ? `Withdrawal to ${to}` : 'Withdrawal',
                 status: pv ? pv.label : (WITHDRAWAL_LABEL[st] || st), tone: pv ? pv.tone : st === 'successful' ? 'ok' : st === 'failed' ? 'bad' : 'warn',
                 payoutId: t.payoutId || null, settled: pv ? !pv.open : st !== 'processing' };
    }
    // A row type the artisan ledger is not known to carry: shown as recorded, flagged.
    return { ...base, kind: 'other', sign: '', title: (t && t.description) || 'Transaction', status: (t && t.status) || 'Recorded', tone: 'warn', unknownType: type || null };
}

/**
 * Everything the Earnings screen draws.
 * @param {{ artisan: object, escrows?: object[], payouts?: object[], transactions?: object[],
 *           ledgerComplete?: boolean }} input
 *        ledgerComplete: every transaction row has been read (reconciliation is meaningful)
 */
export function earningsModel({ artisan, escrows = [], payouts = [], transactions = [], ledgerComplete = false } = {}) {
    const wallet = deriveArtisanWallet({ artisan, escrows, payouts });
    const summary = earningsSummary(transactions);
    const reconciliation = ledgerComplete ? reconcileArtisanWallet({ artisan, transactions, payouts }) : null;
    const job = (e) => ({ escrowId: e.id || null, bookingId: e.bookingId || null, kind: e.kind || 'job',
                          share: fromP(toP(e.artisanShare)), gross: has(e.amount) ? fromP(toP(e.amount)) : null,
                          fee: has(e.commission) ? fromP(toP(e.commission)) : null });
    const issues = [];
    if (wallet.issues.includes('withdrawn_total_below_in_transit')) issues.push('Your paid-out total could not be confirmed from your payout records.');
    if (reconciliation && !reconciliation.ok) {
        for (const c of reconciliation.checks.filter((x) => !x.ok)) {
            issues.push(`Your ${c.name === 'earned' ? 'earned total' : c.name === 'withdrawn' ? 'withdrawn total' : 'available balance'} (${fmtGHS(c.actual)}) does not match your records (${fmtGHS(c.expected)}).`);
        }
    }
    if (summary.mismatches.length) issues.push(`${summary.mismatches.length} earning record${summary.mismatches.length === 1 ? '' : 's'} where the fee and the amount do not add up to the job price.`);
    return {
        wallet, summary, reconciliation,
        held: escrows.filter((e) => e && e.status === 'held').map(job),
        disputed: escrows.filter((e) => e && e.status === 'disputed').map(job),
        payouts: [...payouts].map(payoutView).sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || ''))),
        issues,
    };
}

// ── Job payments (escrow) ─────────────────────────────────────────────────────

const ESCROW_LABEL = {
    held:     ['Held until the customer confirms', 'warn'],
    disputed: ['In dispute · Fidus X support is reviewing', 'bad'],
    released: ['Paid to your balance', 'ok'],
};

/**
 * A customer's payment for a job, as its escrow record says (escrow.js and
 * disputes.js are the only writers). Who wrote a refund, and why, are not shown:
 * those are support's notes.
 */
export function escrowView(e) {
    const s = String(e && e.status || '').toLowerCase();
    const partial = s === 'refunded' && e.resolutionType === 'partial';
    const [label, tone] = ESCROW_LABEL[s]
        || (partial ? ['Dispute settled by Fidus X support', 'info']
        : s === 'refunded' ? ['Returned to the customer', '']
        : ['Status not recorded', 'warn']);
    const gross = has(e && e.amount) ? fromP(toP(e.amount)) : null;
    const share = has(e && e.artisanShare) ? fromP(toP(e.artisanShare)) : null;
    return {
        escrowId: (e && e.id) || null, bookingId: (e && e.bookingId) || null,
        kind: e && e.kind === 'callout' ? 'callout' : 'job',
        status: s || null, label, tone,
        gross, fee: has(e && e.commission) ? fromP(toP(e.commission)) : null, share,
        // What actually reached each side once it closed.
        toYou: s === 'released' ? share : partial && has(e.artisanAmount) ? fromP(toP(e.artisanAmount)) : s === 'refunded' ? 0 : null,
        toCustomer: partial && has(e.customerAmount) ? fromP(toP(e.customerAmount)) : s === 'refunded' ? gross : null,
        at: (e && (e.releasedAt || e.refundedAt || e.disputedAt || e.createdAt)) || null,
        open: s === 'held' || s === 'disputed',
    };
}

// ── The full ledger ───────────────────────────────────────────────────────────

/** The live list's size (walletRepository.subscribeToArtisanTransactions). */
export const LIVE_LEDGER_ROWS = 60;
/** The most rows one read of the whole ledger takes; past this it is not checked here. */
export const LEDGER_CHECK_LIMIT = 1000;

/**
 * The ledger as far as it has been read: the full read (if any) under the live
 * newest rows, by id — so a row that changed since the full read shows as it is
 * now, and a row written since is included.
 * @returns {{ rows: object[], complete: boolean, tooMany: boolean }}
 */
export function mergeLedger({ live = [], liveFromServer = false, full = null } = {}) {
    const byId = new Map();
    for (const r of full || []) if (r && r.id) byId.set(r.id, r);
    for (const r of live) if (r && r.id) byId.set(r.id, r);
    const rows = [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    // Complete only on the SERVER's word: the live page came back short of its
    // limit, or a full read came back short of its own.
    const liveShort = liveFromServer && live.length < LIVE_LEDGER_ROWS;
    const fullShort = Array.isArray(full) && full.length < LEDGER_CHECK_LIMIT;
    return { rows, complete: liveShort || fullShort, tooMany: Array.isArray(full) && full.length >= LEDGER_CHECK_LIMIT };
}

// ── Withdrawing ───────────────────────────────────────────────────────────────

/**
 * Whether Withdraw can be opened, and if not, why — in words.
 *   live      the figures came from the server on this visit (never from a
 *             cached paint: money is backend-authoritative, CLAUDE.md §1)
 *   account   the payout account on file (private/kyc), null when none,
 *             undefined while it is still being read
 */
export function withdrawGate({ live, account, available, min }) {
    if (!live) return { can: false, reason: 'Checking your balance with Fidus X…' };
    if (account === undefined) return { can: false, reason: 'Loading your payout account…' };
    if (!account) return { can: false, reason: 'You have no payout account on file. Contact support to add one.', support: true };
    if (toP(available) < toP(min)) return { can: false, reason: `You can withdraw once you have ${formatGHS(min)} available.` };
    return { can: true, reason: '' };
}

/**
 * Why an amount cannot be withdrawn, or '' when it can be asked for. Mirrors
 * the server's own checks (functions/financial/transfers.js) so the artisan is
 * told in words, never faced with a greyed-out button; the server still
 * decides, and also refuses money its verified ledger cannot account for.
 */
export function withdrawProblem(raw, { available, min }) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount in cedis, for example 50.';
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return 'Use at most 2 decimal places (pesewas).';
    if (amount < min) return `The minimum withdrawal is ${formatGHS(min)}.`;
    if (toP(amount) > toP(available)) return `That is more than you can withdraw (${formatGHS(available)}).`;
    return '';
}

const DEFINITE = ['failed-precondition', 'invalid-argument', 'not-found', 'already-exists', 'out-of-range'];

/**
 * Where a withdrawal error is shown and whether the attempt is over.
 *
 *   attemptSpent  the server answered and this attempt is finished (a refusal, or
 *                 Paystack rejected it and the balance was restored): the next
 *                 try is a new request
 *   uncertain     nobody knows whether it started: the SAME request is retried,
 *                 which the server answers with the existing payout — it cannot
 *                 pay twice (payouts/{uid}_{requestId})
 */
export function withdrawalError(err) {
    const code = String(err && err.code || '').replace(/^functions\//, '');
    const msg  = String(err && err.message || '').trim();
    if (code === 'rate-limited') {
        const s = Math.max(1, Math.ceil(Number(err.waitMs || 0) / 1000));
        return { where: 'sheet', message: `Please wait ${s} second${s === 1 ? '' : 's'} before trying again.`, attemptSpent: false, uncertain: false };
    }
    if (code === 'permission-denied') return { where: 'pin', message: 'Incorrect PIN. Try again.', attemptSpent: false, uncertain: false };
    if (code === 'resource-exhausted') return { where: 'pin', message: msg || 'Too many attempts. Try again later.', attemptSpent: false, uncertain: false };
    if (code === 'failed-precondition' && /security pin/i.test(msg)) return { where: 'pin', message: msg, attemptSpent: false, uncertain: false };
    if (code === 'unauthenticated') return { where: 'sheet', message: 'Your session has expired. Sign in again to withdraw.', attemptSpent: false, uncertain: false };
    if (DEFINITE.includes(code)) return { where: 'sheet', message: msg || 'Your withdrawal could not be made.', attemptSpent: true, uncertain: false };
    return { where: 'sheet', uncertain: true, attemptSpent: false,
             message: 'We could not confirm whether your withdrawal started. Check Withdrawals on this screen before trying again — trying again with the same amount cannot pay you twice.' };
}

/**
 * What the server's answer means, in words. Only Paystack's confirmation
 * (status 'success') is "paid"; anything open is said to be open. A repeated
 * request returns the EXISTING payout, which may already have failed.
 * @param {{ status: string, ref?: string, duplicate?: boolean }} res  processArtisanWithdrawal's answer
 * @param {{ amount: number, to?: string }} ctx
 */
export function withdrawalOutcome(res, { amount, to } = {}) {
    const s = String(res && res.status || '').toLowerCase();
    const dup = !!(res && res.duplicate);
    const what = dup ? 'Your withdrawal' : formatGHS(amount);
    const dest = to || 'your Mobile Money';
    const ref = res && res.ref ? ` Ref ${res.ref}.` : '';
    if (s === 'success') return { done: true, tone: 'ok', message: `${what} was paid to ${dest}.${ref}` };
    if (s === 'failed' || s === 'reversed') {
        return { done: false, tone: 'bad', attemptSpent: true,
                 message: `${what} did not go through. Its status is under Withdrawals on this screen.${ref}` };
    }
    if (s === 'unknown') {
        return { done: true, tone: 'warn', message: `${what} is being confirmed with the provider. The amount stays held until it settles; we'll notify you.${ref}` };
    }
    if (s === 'processing' || s === 'reserved' || s === 'pending') {
        return { done: true, tone: 'info', message: `${what} to ${dest} has been requested. It shows under Withdrawals until the provider confirms it; we'll notify you.${ref}` };
    }
    return { done: true, tone: 'warn', message: `${what} was sent to Fidus X, but its status was not returned. Check Withdrawals on this screen.${ref}` };
}

/** The app's one money format (shared/js/utils/currency.js). */
export const fmtGHS = (v) => formatGHS(v);
