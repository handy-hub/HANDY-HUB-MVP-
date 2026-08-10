// paymentPage.js — Handy Hub's internal Mobile Money payment experience.
//
// Replaces the Paystack popup for wallet top-ups. The customer stays inside Handy
// Hub the whole time: pick a saved MoMo method → amount → summary → 4-digit Handy
// Hub PIN → the backend calls the Paystack Charge API → the provider pushes the
// approval to the phone → the customer approves with their REAL MoMo PIN → the
// existing charge.success webhook credits the wallet.
//
// Single-shell state machine:  compose → pin → authorize → result
//
// SIMULATE: the real charge requires the initiateTopupCharge Cloud Function, which
// needs Blaze + deploy. Until then, set SIMULATE = true to walk the full UX with a
// faked backend (no real charge). Flip to false once the function is deployed.

import { getAppContainer } from '../../../shared/js/app/container.js';
import { showToast } from '../../../shared/js/components/toast.js';
import {
    createPaymentRepository, PROVIDER_META, PROVIDER_NAMES,
} from '../../../shared/js/data/repositories/paymentRepository.js';
import { PLATFORM_CONFIG, FUNCTIONS_REGION } from '../../../shared/js/config/appConfig.js';
import { maskPhone } from '../../../shared/js/utils/momo.js';
import { formatGHS } from '../../../shared/js/utils/currency.js';
import { mapError } from '../../../shared/js/utils/errorCopy.js';

// ── Toggle: no real money is moved while this is true ──────────────────────────
const SIMULATE = true;

const MIN_TOPUP = PLATFORM_CONFIG?.minTopupGHS ?? 1;
const $ = (id) => document.getElementById(id);

const S = {
    uid: null,
    db: null,
    accounts: [],
    selectedId: null,
    amount: 0,
    pin: '',
    view: 'compose',
    paymentId: null,
    unsubAccounts: null,
    unsubPayment: null,
    simTimer: null,
};

// ── View switching ─────────────────────────────────────────────────────────────
const VIEW = {
    compose:   { kicker: 'Top up',   title: 'Add money',          progress: 33 },
    pin:       { kicker: 'Authorise', title: 'Security PIN',       progress: 66 },
    authorize: { kicker: 'Approve',   title: 'On your phone',      progress: 90 },
    otp:       { kicker: 'Verify',    title: 'Enter code',         progress: 90 },
    result:    { kicker: 'Done',      title: 'Payment',            progress: 100 },
};

function setView(name) {
    S.view = name;
    ['compose', 'pin', 'authorize', 'result'].forEach(v => { $(`view-${v}`).hidden = v !== name; });
    const m = VIEW[name];
    $('pay-kicker').textContent = m.kicker;
    $('pay-title').textContent  = m.title;
    $('pay-progress').style.width = `${m.progress}%`;
    $('pay-body').scrollTo({ top: 0 });
    // CTA is only shown on compose (Continue) and result (Done / Try again).
    $('pay-cta-wrap').style.display = (name === 'compose' || name === 'otp' || name === 'result') ? '' : 'none';
}

// ── Selected account helpers ────────────────────────────────────────────────────
function selectedAccount() {
    return S.accounts.find(a => a.id === S.selectedId) || null;
}
function accMasked(acc) {
    return acc?.data?.phoneMasked || maskPhone(acc?.data?.phone || '');
}
function accProviderName(acc) {
    return PROVIDER_NAMES[acc?.data?.provider] || acc?.data?.provider || 'Mobile Money';
}

// ── VIEW 1: compose ─────────────────────────────────────────────────────────────
function renderMethods() {
    const wrap = $('pay-methods');
    const list = S.accounts.filter(a => !a.data.deleted && a.data.active !== false);

    if (!list.length) {
        wrap.innerHTML = `<div class="pay-empty">No saved Mobile Money account yet.<br/>Add one to continue.</div>`;
        S.selectedId = null;
        updateCompose();
        return;
    }

    // Keep selection if still valid, else default → first.
    if (!S.selectedId || !list.some(a => a.id === S.selectedId)) {
        S.selectedId = (list.find(a => a.data.isDefault) || list[0]).id;
    }

    wrap.innerHTML = list.map(acc => {
        const meta = PROVIDER_META[acc.data.provider] || {};
        const on   = acc.id === S.selectedId;
        return `
          <button class="pay-method ${on ? 'active' : ''}" data-id="${acc.id}" type="button">
            <span class="pay-method-logo">${meta.logo || ''}</span>
            <span class="pay-method-info">
              <span class="pay-method-num">${accMasked(acc)}</span>
              <span class="pay-method-prov">${accProviderName(acc)}</span>
            </span>
            ${acc.data.isDefault ? '<span class="pay-method-badge">Default</span>' : ''}
            <span class="pay-method-radio"></span>
          </button>`;
    }).join('');

    wrap.querySelectorAll('.pay-method').forEach(btn => {
        btn.addEventListener('click', () => { S.selectedId = btn.dataset.id; renderMethods(); updateCompose(); });
    });
    updateCompose();
}

function updateCompose() {
    const acc   = selectedAccount();
    const valid = S.amount >= MIN_TOPUP && !!acc;

    const sum = $('pay-summary');
    if (S.amount > 0 && acc) {
        sum.hidden = false;
        $('sum-amount').textContent = formatGHS(S.amount);
        $('sum-total').textContent  = formatGHS(S.amount);
        $('sum-method').textContent = `${accProviderName(acc)} · ${accMasked(acc)}`;
    } else {
        sum.hidden = true;
    }

    const cta = $('pay-cta');
    cta.disabled = !valid;
    cta.textContent = valid ? `Continue · ${formatGHS(S.amount)}` : 'Continue';
    $('pay-cta-meta').textContent =
        S.amount > 0 && S.amount < MIN_TOPUP ? `Minimum top-up is ${formatGHS(MIN_TOPUP)}.` : '';
}

function wireCompose() {
    const input = $('pay-amount');
    input.addEventListener('input', () => {
        S.amount = parseFloat(input.value) || 0;
        $('pay-quick').querySelectorAll('button').forEach(b => b.classList.remove('active'));
        updateCompose();
    });
    $('pay-quick').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-amount]');
        if (!b) return;
        $('pay-quick').querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        input.value = b.dataset.amount;
        S.amount = Number(b.dataset.amount);
        updateCompose();
    });
    $('pay-add-method').addEventListener('click', () => { window.location.href = 'topup.html'; });
}

// ── VIEW 2: pin ─────────────────────────────────────────────────────────────────
function renderPin() {
    const acc = selectedAccount();
    $('pin-sub').innerHTML =
        `This is your <strong>Handy Hub</strong> PIN — not your Mobile Money PIN. ` +
        `It authorises a ${formatGHS(S.amount)} top-up from ${accMasked(acc)}.`;
    setPin('');
    $('pin-err').textContent = '';
    $('pin-wrap').classList.remove('err');
}

function setPin(val) {
    S.pin = val.slice(0, 4);
    const dots = $('pin-dots').querySelectorAll('.pin-dot');
    dots.forEach((d, i) => d.classList.toggle('filled', i < S.pin.length));
}

function pinError(msg) {
    $('pin-err').textContent = msg;
    const w = $('pin-wrap');
    w.classList.add('err');
    setTimeout(() => { w.classList.remove('err'); setPin(''); }, 500);
}

function wirePin() {
    $('pin-pad').addEventListener('click', (e) => {
        const btn = e.target.closest('.pin-key');
        if (!btn) return;
        const k = btn.dataset.k;
        if (k === 'del')      { setPin(S.pin.slice(0, -1)); return; }
        if (k === 'forgot')   { showToast('You can reset your PIN in Settings → Security.', 'info'); return; }
        if (!/^\d$/.test(k))  return;
        if (S.pin.length >= 4) return;
        setPin(S.pin + k);
        if (S.pin.length === 4) setTimeout(submitPin, 120);
    });
}

// Lazy-load a callable (the real charge path only runs once functions are deployed).
async function _fn(name) {
    const { getFunctions, httpsCallable } =
        await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js');
    const { firebaseApp } =
        await import('../../../shared/js/backend/providers/firebase/firebaseConfig.js');
    return httpsCallable(getFunctions(firebaseApp, FUNCTIONS_REGION), name);
}

async function submitPin() {
    const pin = S.pin;
    if (pin.length !== 4) return;

    if (SIMULATE) {
        // Fake: PIN "0000" fails so you can see the error state; anything else passes.
        if (pin === '0000') { pinError('Incorrect PIN. Please try again.'); return; }
        S.paymentId = `SIM-${Date.now()}`;
        // Amount GHS 7 previews the send_otp branch; any other amount → approve-on-phone.
        if (S.amount === 7) {
            routeNextAction('submit_otp');
        } else {
            routeNextAction('approve_on_phone');
            S.simTimer = setTimeout(() => onPaymentStatus('successful', {
                amountMinor: Math.round(S.amount * 100),
                paystackRef: `SIM-${Date.now().toString(36).toUpperCase()}`,
            }), 3800);
        }
        return;
    }

    // ── Real path (needs the deployed initiateTopupCharge Cloud Function) ────────
    try {
        const call = await _fn('initiateTopupCharge');
        const { data } = await call({
            amount:          S.amount,
            paymentMethodId: S.selectedId,
            pin,
            purpose:         'topup',
        });
        if (!data?.paymentId) throw new Error('Could not start the payment. Please try again.');
        S.paymentId = data.paymentId;
        startTracking(data.paymentId);
        routeNextAction(data.nextAction || 'approve_on_phone', data);
    } catch (err) {
        const code = err?.code || '';
        if (/pin/i.test(err?.message || '') || code.includes('permission-denied')) {
            pinError(mapError(err, 'Incorrect PIN. Please try again.'));
            return;
        }
        showToast(mapError(err, 'Could not start the payment. Please try again.'));
        setPin('');
    }
}

// ── VIEW 3: authorize / OTP (the two Paystack Charge next-actions) ───────────────

// Keep a pending payment recoverable: reopening payment.html?paymentId= resumes it.
function recoverUrl() {
    if (!S.paymentId) return;
    try {
        const u = new URL(location.href);
        u.searchParams.set('paymentId', S.paymentId);
        history.replaceState(history.state, '', u.pathname + u.search);
    } catch { /* non-fatal */ }
}

// Listen to the authoritative payment document for the terminal outcome. This runs
// UNDER whichever interactive view (approve-on-phone or OTP) is showing, so the
// webhook/verification result always wins.
function startTracking(paymentId) {
    if (SIMULATE) return;
    if (S.unsubPayment) S.unsubPayment();
    S.unsubPayment = S.db.subscribeToDocument('payments', paymentId,
        (snap) => {
            if (!snap?.exists) return;
            const d = snap.data || {};
            const st = String(d.status || '').toLowerCase();
            if (st === 'successful') onPaymentStatus('successful', d);
            else if (['failed', 'expired', 'cancelled'].includes(st)) onPaymentStatus(st, d);
        },
        () => { const el = $('auth-status'); if (el) el.textContent = 'Connection lost — retrying…'; });
}

// Paystack's Charge API returns a next-action; map it to the right screen.
function routeNextAction(nextAction, data = {}) {
    const a = String(nextAction || '').toLowerCase();
    if (a === 'submit_otp' || a === 'send_otp')       return enterOtp();
    if (a === 'succeeded'  || a === 'successful')      return onPaymentStatus('successful', data);
    if (a === 'failed')                                return onPaymentStatus('failed', data);
    // approve_on_phone / pay_offline / processing / unknown → wait for phone approval
    return enterAuthorize();
}

function enterAuthorize() {
    setView('authorize');
    $('auth-num').textContent = accMasked(selectedAccount());
    $('auth-status').innerHTML = `<span class="auth-spin"></span> Waiting for approval…`;
    recoverUrl();
}

function enterOtp() {
    setView('otp');
    $('otp-num').textContent = accMasked(selectedAccount());
    $('otp-input').value = '';
    $('otp-err').textContent = '';
    setTimeout(() => $('otp-input').focus(), 60);
    setCta('Confirm code', submitOtp);
    recoverUrl();
}

async function submitOtp() {
    const otp = ($('otp-input').value || '').replace(/\D/g, '');
    if (otp.length < 4) { $('otp-err').textContent = 'Enter the code from the SMS.'; return; }

    const cta = $('pay-cta');
    cta.disabled = true; cta.textContent = 'Verifying…';
    $('otp-err').textContent = '';

    if (SIMULATE) {
        setTimeout(() => {
            if (otp === '123456') {
                onPaymentStatus('successful', {
                    amountMinor: Math.round(S.amount * 100),
                    paystackRef: `SIM-${Date.now().toString(36).toUpperCase()}`,
                });
            } else {
                cta.disabled = false; cta.textContent = 'Confirm code';
                $('otp-err').textContent = 'Incorrect code. Please try again.';
            }
        }, 900);
        return;
    }

    // ── Real path — server submits the OTP to Paystack /charge/submit_otp ─────────
    try {
        const call = await _fn('submitTopupOtp');
        const { data } = await call({ paymentId: S.paymentId, otp });
        cta.disabled = false; cta.textContent = 'Confirm code';
        routeNextAction(data?.nextAction || 'processing', data);
    } catch (err) {
        cta.disabled = false; cta.textContent = 'Confirm code';
        $('otp-err').textContent = mapError(err, 'Incorrect or expired code. Please try again.');
    }
}

function onPaymentStatus(status, data = {}) {
    if (S.unsubPayment) { S.unsubPayment(); S.unsubPayment = null; }
    clearTimeout(S.simTimer);
    const amt = data.amountMinor != null ? Number(data.amountMinor) / 100 : S.amount;
    if (status === 'successful') {
        showResult(true, { amount: amt, ref: data.paystackRef || S.paymentId });
    } else {
        const reason = data.failureReason
            || (status === 'expired' ? 'The request timed out before it was approved.'
                : status === 'cancelled' ? 'The payment was cancelled.'
                : 'The payment could not be completed.');
        showResult(false, { reason });
    }
}

// ── VIEW 4: result ──────────────────────────────────────────────────────────────
function showResult(ok, { amount, ref, reason } = {}) {
    setView('result');
    const icon = $('res-icon'), svg = $('res-svg');
    icon.className = `res-icon ${ok ? 'ok' : 'bad'}`;
    if (ok) {
        svg.innerHTML = `<path d="M20 7L10.25 16.75L6 12.5" stroke="#16a34a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
        $('res-title').textContent = 'Wallet credited!';
        $('res-amt').hidden = false; $('res-amt').textContent = `+ ${formatGHS(amount)}`;
        $('res-ref').hidden = false; $('res-ref').textContent = `Ref ${ref || '—'}`;
        $('res-sub').textContent = SIMULATE
            ? 'Simulated success — no real money moved.'
            : 'Your top-up was successful and added to your wallet.';
        setCta('Done', () => { window.location.href = 'topup.html'; });
    } else {
        svg.innerHTML = `<path d="M18 6L6 18M6 6l12 12" stroke="#dc2626" stroke-width="2.6" stroke-linecap="round"/>`;
        $('res-title').textContent = 'Payment not completed';
        $('res-amt').hidden = true;
        $('res-ref').hidden = true;
        $('res-sub').textContent = reason || 'Please try again.';
        setCta('Try again', () => {
            S.paymentId = null; setPin('');
            try { const u = new URL(location.href); u.searchParams.delete('paymentId'); history.replaceState(history.state, '', u.pathname + u.search); } catch {}
            setView('compose'); updateCompose();
        });
    }
}

// ── CTA / back ──────────────────────────────────────────────────────────────────
let _ctaAction = null;
function setCta(label, action) {
    const btn = $('pay-cta');
    btn.disabled = false;
    btn.textContent = label;
    _ctaAction = action;
    $('pay-cta-meta').textContent = '';
}

function wireChrome() {
    $('pay-cta').addEventListener('click', () => {
        if (S.view === 'compose') {
            if (S.amount < MIN_TOPUP || !selectedAccount()) return;
            renderPin(); setView('pin');
        } else if (typeof _ctaAction === 'function') {
            _ctaAction();
        }
    });
    $('pay-back').addEventListener('click', () => {
        if (S.view === 'pin')            { setView('compose'); updateCompose(); }
        else if (S.view === 'authorize' || S.view === 'otp') { showToast('Payment is still processing — you can return to it.', 'info'); }
        else if (S.view === 'result')    { window.location.href = 'topup.html'; }
        else if (history.length > 1)     { history.back(); }
        else                             { window.location.href = 'profile.html'; }
    });
}

// ── Boot ────────────────────────────────────────────────────────────────────────
async function init() {
    const { services: { authService, databaseService } } = getAppContainer();
    S.db = databaseService;

    if (SIMULATE) $('pay-sim').hidden = false;

    wireCompose();
    wirePin();
    wireChrome();

    authService.subscribeToAuthState((user) => {
        if (!user) { window.location.href = 'login.html'; return; }
        S.uid = user.uid;
        const repo = createPaymentRepository({ databaseService });

        if (S.unsubAccounts) S.unsubAccounts();
        S.unsubAccounts = repo.subscribeToAccounts(
            user.uid,
            (records) => { S.accounts = records; if (S.view === 'compose') renderMethods(); },
            (err) => console.warn('[payment] accounts sub error:', err),
        );
    });

    // Prefill amount (?amount=) and recover a pending charge (?paymentId=).
    const params = new URLSearchParams(location.search);
    const amt = parseFloat(params.get('amount'));
    if (Number.isFinite(amt) && amt > 0) { $('pay-amount').value = amt; S.amount = amt; }

    const resumeId = params.get('paymentId');
    if (resumeId && !SIMULATE) { S.paymentId = resumeId; startTracking(resumeId); enterAuthorize(); }
    else { setView('compose'); updateCompose(); }
}

window.addEventListener('pagehide', () => {
    if (S.unsubAccounts) S.unsubAccounts();
    if (S.unsubPayment) S.unsubPayment();
    clearTimeout(S.simTimer);
});

init();
