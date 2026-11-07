/**
 * artisan-app/js/earningsScreen.js — draws the Earnings screen (Phase 4).
 *
 * Rendering only. Every figure, label and verdict comes from
 * shared/js/domain/artisanEarnings.js, which reads the records the server
 * writes (artisans/{id} balances, escrow, payouts, artisans/{id}/transactions)
 * and computes no balance of its own. Every string that came from a record is
 * escaped. The withdrawal itself is the page's (wallet.html), so the call that
 * moves money stays where it can be read in one place.
 */
import { icon } from './fx/icons.js';
import { formatGHS } from '../../shared/js/utils/currency.js';
import { ledgerRow } from '../../shared/js/domain/artisanEarnings.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => esc(formatGHS(v));
const jobHref = (id) => `job.html?id=${encodeURIComponent(id)}`;
const TONE_CHIP = { ok: 'fx-chip--ok', warn: 'fx-chip--warn', bad: 'fx-chip--bad', info: 'fx-chip--info', '': '' };

/** "6 Nov 2026 · 14:05" in the artisan's own time zone; '' when unknown. */
export function fmtWhen(v) {
    if (!v) return '';
    const d = new Date(typeof v === 'object' && typeof v.toMillis === 'function' ? v.toMillis() : v);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Which job a payment was for (audit UI-009) ────────────────────────────────

/**
 * The service and the customer's first name for a booking, read once each from
 * bookings/{id} (the artisan's own jobs; the rules allow the read) — only after
 * the LIVE data has arrived, never for a cached paint, and at most `max` reads
 * a visit. Display only: no figure on this screen comes from a booking.
 */
export function createBookingNames({ getDocument, serviceLabel, max = 20, onChange = () => {} }) {
    const names = new Map();   // bookingId → { service, name } | null (read, nothing usable)
    let reads = 0;
    let live = false;
    return {
        setLive(v) { live = !!v; },
        get reads() { return reads; },
        /** "Plumbing · Ama", "Plumbing", or null while unknown. */
        label(bookingId) {
            const n = bookingId ? names.get(bookingId) : null;
            if (!n || !n.service) return null;
            return n.name ? `${n.service} · ${n.name}` : n.service;
        },
        async load(ids) {
            if (!live) return;
            let changed = false;
            for (const id of [...new Set(ids.filter(Boolean))]) {
                if (names.has(id)) continue;
                if (reads >= max) break;
                names.set(id, null);
                reads++;
                try {
                    const snap = await getDocument('bookings', id);
                    if (snap && snap.exists) {
                        const b = snap.data || {};
                        names.set(id, { service: serviceLabel(b.serviceType) || serviceLabel(b.service) || null,
                                        name: typeof b.customerFirstName === 'string' && b.customerFirstName.trim() ? b.customerFirstName.trim() : null });
                        changed = true;
                    }
                } catch (_) { /* unreadable: the row keeps its own words */ }
            }
            if (changed) onChange();
        },
        /** A Map shaped for ledgerRow's `bookings` context. */
        asLedgerContext() {
            const m = new Map();
            for (const id of names.keys()) { const l = this.label(id); if (l) m.set(id, { service: l }); }
            return m;
        },
    };
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const row = (k, v, { cls = '', note = '', id = '' } = {}) =>
    `<div class="fx-ledger__row ${cls}"${id ? ` data-figure="${id}"` : ''}><dt class="fx-ledger__k">${k}</dt><dd class="fx-ledger__v fx-num">${v}</dd>${note ? `<dd class="fx-ledger__note">${note}</dd>` : ''}</div>`;

function sect(id, title, body, { count = null } = {}) {
    return `<section class="fx-sect fx-earn__sect" aria-labelledby="${id}"><div class="fx-sect__head"><h2 class="fx-sect__title" id="${id}">${esc(title)}${count !== null ? ` <span class="fx-num">(${count})</span>` : ''}</h2></div>${body}</section>`;
}

const chip = (label, tone) => `<span class="fx-chip ${TONE_CHIP[tone] || ''}">${esc(label)}</span>`;

// ── The screen ────────────────────────────────────────────────────────────────

/** The figure at the top, with Withdraw and, when it is off, why. */
export function heroHtml(m, ui) {
    const a = ui.account;
    const to = a ? [a.providerName, a.phone, a.accountName].filter(Boolean).map(esc).join(' · ') : '';
    return `<section class="fx-earn__hero fx-stack--2" aria-labelledby="earn-avail-k">
      <p class="fx-label" id="earn-avail-k">Available to withdraw</p>
      <p class="fx-display fx-num fx-earn__avail" id="available-balance">${money(m.wallet.available)}</p>
      ${to ? `<p class="fx-meta">Paid to ${to}</p>` : ''}
      <button class="fx-btn fx-btn--primary fx-btn--l fx-btn--block" id="withdraw-btn" type="button" aria-describedby="withdraw-why"${ui.gate.can ? '' : ' disabled'}>Withdraw</button>
      <p class="fx-field__hint" id="withdraw-why">${esc(ui.gate.reason)}${ui.gate.support ? ` <a class="fx-link" href="support.html">Contact support</a>` : ''}</p>
    </section>`;
}

/** Where the money is: each figure from the record that is authoritative for it. */
export function moneyHtml(m) {
    const w = m.wallet;
    const rows = [
        row('Available to withdraw', money(w.available), { id: 'available', note: 'Your balance, after the platform fee. Yours to withdraw.' }),
        row(`Held for jobs in progress${w.heldJobs ? ` (${w.heldJobs})` : ''}`, money(w.pendingRelease), { id: 'held', cls: 'fx-ledger__row--pending',
            note: 'Your share of what customers have paid, held by Fidus X until they confirm the job is done. Not yours to withdraw yet.' }),
    ];
    if (w.inDispute > 0) rows.push(row('In dispute', money(w.inDispute), { id: 'dispute', cls: 'fx-ledger__row--pending', note: 'Held while Fidus X support reviews a dispute.' }));
    if (w.inTransit > 0) rows.push(row('On its way to your Mobile Money', money(w.inTransit), { id: 'transit', cls: 'fx-ledger__row--pending', note: 'Withdrawals the provider has not confirmed yet.' }));
    rows.push(row('Paid out to date', w.paidOut === null ? 'Not confirmed' : money(w.paidOut), { id: 'paid' }));
    rows.push(row('Earned to date', money(w.totalEarned), { id: 'earned', cls: 'fx-ledger__row--total', note: 'Everything paid to your balance so far: job payments after the platform fee, and tips.' }));
    return sect('earn-money', 'Your money', `<div class="fx-sect__body"><dl class="fx-ledger fx-earn__ledger">${rows.join('')}</dl></div>`);
}

/** The fee, as the server took it, row by row. */
export function feesHtml(m, ui) {
    const s = m.summary;
    if (!s.earnings && !s.tips) return '';
    const scope = ui.ledger.complete
        ? `From all ${s.earnings} job payment${s.earnings === 1 ? '' : 's'} on your record.`
        : `From your latest ${s.earnings} job payment${s.earnings === 1 ? '' : 's'}.`;
    const rows = [
        row(`Customers paid for ${s.earnings} job${s.earnings === 1 ? '' : 's'}`, money(s.gross), { id: 'gross' }),
        row('Platform fee', `− ${money(s.fee)}`, { id: 'fee', cls: 'fx-ledger__row--sub' }),
        row('You received', money(s.net), { id: 'net', cls: 'fx-ledger__row--total' }),
    ];
    if (s.tips) rows.push(row(`Tips (${s.tips}) · no fee`, money(s.tipsTotal), { id: 'tips' }));
    const notes = [scope, 'Each payment under Activity shows the fee taken from it.'];
    if (s.feeChanged) notes.push('The fee rate was not the same on every job; each payment shows the rate it was charged at.');
    return sect('earn-fees', 'Fees', `<div class="fx-sect__body"><dl class="fx-ledger fx-earn__ledger">${rows.join('')}</dl><p class="fx-ledger__note">${esc(notes.join(' '))}</p></div>`);
}

/** The check of the stored totals against the ledger — shown, whatever it finds. */
export function checkHtml(m, ui) {
    if (!ui.live) return '';
    const L = ui.ledger;
    if (m.issues.length && ui.issuesStable) {
        return `<div class="fx-notice fx-notice--bad" role="alert" data-check="mismatch">${icon('alert', 'fx-notice__icon')}<div class="fx-notice__body">
          <p class="fx-notice__title">Your figures do not match your records</p>
          <ul class="fx-earn__issues">${m.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
          <p>Nothing here changes your money. Fidus X support can look into it.</p>
          <div class="fx-notice__actions"><a class="fx-btn fx-btn--secondary fx-btn--s" href="support.html">Contact support</a></div></div></div>`;
    }
    if (m.reconciliation && m.reconciliation.ok && L.complete) {
        return `<p class="fx-earn__check" data-check="ok">${icon('check')}<span>Your balance matches your records (${L.count} record${L.count === 1 ? '' : 's'} checked).</span></p>`;
    }
    if (L.tooMany) {
        return `<p class="fx-meta fx-earn__checknote" data-check="too-many">You have more records than this screen can check at once. Fidus X support can check them for you.</p>`;
    }
    if (L.complete) return '';   // complete, but the figures are still settling: said once they agree, or the mismatch above
    return `<div class="fx-earn__checknote fx-stack--2" data-check="partial"><p class="fx-meta">${L.failed
        ? 'We could not load all your records to check your balance against them.'
        : 'Your balance is checked against your records once all of them have loaded.'}</p>
      <button class="fx-btn fx-btn--tertiary fx-btn--s" type="button" data-act="check"${L.loading ? ' disabled aria-busy="true"' : ''}>${L.loading ? 'Checking…' : L.failed ? 'Try again' : 'Check against all my records'}</button></div>`;
}

function escrowRowHtml(v, names) {
    const title = names.label(v.bookingId) || (v.kind === 'callout' ? 'Visit fee' : 'Job');
    const parts = [];
    if (v.gross !== null) parts.push(`Customer paid ${formatGHS(v.gross)}`);
    if (v.fee !== null && v.open) parts.push(`fee ${formatGHS(v.fee)}`);
    if (v.status === 'refunded' && v.toCustomer !== null) {
        parts.length = 0;
        parts.push(v.toYou ? `You received ${formatGHS(v.toYou)} · the customer ${formatGHS(v.toCustomer)}` : `${formatGHS(v.toCustomer)} returned to the customer`);
    }
    // The figure on the right is what is (or will be) yours. A payment returned
    // whole to the customer has none — its amount is in the line above, not a "GHS 0.00".
    const value = v.open ? v.share : v.toYou ? v.toYou : null;
    const inner = `<span class="fx-row__main">
        <span class="fx-row__title">${esc(title)}${v.kind === 'callout' && names.label(v.bookingId) ? ' · visit fee' : ''}</span>
        <span class="fx-earn__line">${chip(v.label, v.tone)}</span>
        ${parts.length ? `<span class="fx-row__meta">${esc(parts.join(' · '))}</span>` : ''}
        ${v.at ? `<span class="fx-row__meta">${esc(fmtWhen(v.at))}</span>` : ''}
      </span>
      <span class="fx-row__trail">${value !== null && value !== undefined ? `<span class="fx-row__value fx-num">${money(value)}</span>` : ''}${v.bookingId ? icon('next') : ''}</span>`;
    return v.bookingId
        ? `<li><a class="fx-row fx-earn__row" href="${jobHref(v.bookingId)}" data-escrow="${esc(v.escrowId)}">${inner}</a></li>`
        : `<li><div class="fx-row fx-earn__row" data-escrow="${esc(v.escrowId)}">${inner}</div></li>`;
}

export function heldHtml(m, ui) {
    const open = [...ui.held, ...ui.disputed];
    const body = open.length
        ? `<ul class="fx-list">${open.map((v) => escrowRowHtml(v, ui.names)).join('')}</ul>`
        : `<p class="fx-meta fx-earn__empty">Nothing is held for you right now. When a customer pays for a job, their payment is held here until they confirm the work is done.</p>`;
    return sect('earn-held', 'Held for your jobs', body, { count: open.length || null });
}

/** Customers' payments that were returned to them (cancelled, or a dispute settled). */
export function returnedHtml(ui) {
    if (!ui.returned.length) return '';
    return sect('earn-returned', 'Returned to customers',
        `<ul class="fx-list">${ui.returned.map((v) => escrowRowHtml(v, ui.names)).join('')}</ul>
         <div class="fx-sect__body"><p class="fx-ledger__note">From your most recent job payments. A payment returned to the customer was never part of your balance.</p></div>`);
}

export function payoutRowHtml(p) {
    const to = [p.provider, p.phone].filter(Boolean).join(' ');
    const meta = [fmtWhen(p.requestedAt) && `Requested ${fmtWhen(p.requestedAt)}`, p.settledAt && !p.open ? `Settled ${fmtWhen(p.settledAt)}` : '', p.ref ? `Ref ${p.ref}` : '']
        .filter(Boolean).join(' · ');
    return `<li><div class="fx-row fx-earn__row" data-payout="${esc(p.id)}">
      <span class="fx-row__main">
        <span class="fx-row__title">${esc(to ? `To ${to}` : 'Withdrawal')}</span>
        <span class="fx-earn__line">${chip(p.label, p.tone)}</span>
        ${meta ? `<span class="fx-row__meta">${esc(meta)}</span>` : ''}
      </span>
      <span class="fx-row__trail"><span class="fx-row__value fx-num">${money(p.amount)}</span></span></div></li>`;
}

export function payoutsHtml(m) {
    const body = m.payouts.length
        ? `<ul class="fx-list">${m.payouts.map(payoutRowHtml).join('')}</ul>`
        : '<p class="fx-meta fx-earn__empty">No withdrawals yet.</p>';
    return sect('earn-payouts', 'Withdrawals', body, { count: m.payouts.length || null });
}

/** One ledger row in the Activity list; it opens its details. */
export function activityRowHtml(r) {
    const cls = r.sign === '+' ? 'fx-earn__amt--in' : r.sign === '−' ? 'fx-earn__amt--out' : '';
    return `<li><button class="fx-row fx-earn__row" type="button" data-txn="${esc(r.id)}" aria-haspopup="dialog">
      <span class="fx-row__main">
        <span class="fx-row__title">${esc(r.title)}</span>
        <span class="fx-earn__line">${chip(r.status, r.tone)}</span>
        ${r.when ? `<span class="fx-row__meta">${esc(fmtWhen(r.when))}</span>` : ''}
      </span>
      <span class="fx-row__trail"><span class="fx-row__value fx-num ${cls}">${r.sign ? `${r.sign} ` : ''}${money(r.amount)}</span>${icon('next')}</span></button></li>`;
}

export function activityHtml(rows, ui) {
    if (!ui.txnsReady) {
        return sect('earn-activity', 'Activity', '<div class="fx-stack" aria-busy="true" data-skeleton><span class="fx-skel fx-skel--row"></span><span class="fx-skel fx-skel--row"></span></div>');
    }
    if (ui.txnsFailed && !rows.length) {
        return sect('earn-activity', 'Activity', '<p class="fx-meta fx-earn__empty" role="status">We couldn\'t load your activity. It appears here once you\'re back online.</p>');
    }
    if (!rows.length) {
        return sect('earn-activity', 'Activity', '<p class="fx-meta fx-earn__empty">No activity yet. Your job payments, tips and withdrawals appear here.</p>');
    }
    const more = !ui.ledger.complete && !ui.ledger.tooMany
        ? `<div class="fx-earn__more"><button class="fx-btn fx-btn--secondary fx-btn--block" type="button" data-act="older"${ui.ledger.loading ? ' disabled aria-busy="true"' : ''}>${ui.ledger.loading ? 'Loading…' : 'Show older activity'}</button></div>`
        : '';
    return sect('earn-activity', 'Activity', `<ul class="fx-list">${rows.map(activityRowHtml).join('')}</ul>${more}`, { count: null });
}

/** The details of one ledger row (the sheet's body). */
export function detailHtml(r) {
    const rows = [row('Amount', `${r.sign ? `${r.sign} ` : ''}${money(r.amount)}`), row('Status', esc(r.status))];
    if (r.when) rows.push(row('Recorded', esc(fmtWhen(r.when))));
    if (r.kind === 'earning') {
        if (r.gross !== null) rows.push(row('Customer paid', money(r.gross)));
        rows.push(row(r.rate !== null ? `Platform fee (${Math.round(r.rate * 1000) / 10}%)` : 'Platform fee', `− ${money(r.fee)}`, { cls: 'fx-ledger__row--sub' }));
        rows.push(row('You received', money(r.amount), { cls: 'fx-ledger__row--total' }));
    }
    if (r.kind === 'tip') rows.push(row('Platform fee', 'None on tips', { cls: 'fx-ledger__row--sub' }));
    if (r.ref) rows.push(row('Reference', esc(r.ref)));
    if (r.kind === 'other') rows.push(row('Recorded as', esc(r.unknownType || 'not stated')));
    const notes = [];
    if (r.kind === 'withdrawal' && !r.settled) notes.push('The provider has not confirmed this withdrawal yet. Its status updates here when they do.');
    if (r.kind === 'other') notes.push('This is not a kind of record this screen knows. Ask Fidus X support about it if it is unexpected.');
    return `<dl class="fx-ledger fx-earn__ledger">${rows.join('')}</dl>
      ${notes.map((n) => `<p class="fx-ledger__note">${esc(n)}</p>`).join('')}
      ${r.bookingId ? `<a class="fx-btn fx-btn--secondary fx-btn--block" href="${jobHref(r.bookingId)}">Open the job</a>` : ''}`;
}

/**
 * The ledger rows as the screen describes them.
 * @param {object[]} transactions  rows (data + id)
 * @param {object[]} payouts       raw payout records (for a withdrawal's state)
 */
export function activityRows(transactions, payouts, names) {
    const payoutsById = new Map((payouts || []).map((p) => [p.id, p]));
    const bookings = names.asLedgerContext();
    return transactions.map((t) => ledgerRow(t, { payoutsById, bookings }));
}

/**
 * The screen under the app bar.
 * @param {{ main: HTMLElement }} dom
 */
export function renderEarnings(dom, m, ui, rows) {
    dom.main.innerHTML = [
        heroHtml(m, ui), checkHtml(m, ui), moneyHtml(m), feesHtml(m, ui), heldHtml(m, ui), payoutsHtml(m), returnedHtml(ui), activityHtml(rows, ui),
    ].join('');
}
