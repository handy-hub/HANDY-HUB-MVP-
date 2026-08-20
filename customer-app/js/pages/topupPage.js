import '../../../shared/js/utils/global-app.js';
import { getAppContainer } from '../../../shared/js/app/container.js';
import { showToast } from '../../../shared/js/components/toast.js';
import {
    createPaymentRepository,
    PROVIDER_META
} from '../../../shared/js/data/repositories/paymentRepository.js';
import { initiatePayment } from '../../../shared/js/services/paystackService.js';
import { createNotification } from '../../../shared/js/services/notificationRepository.js';
import { PLATFORM_CONFIG } from '../../../shared/js/config/appConfig.js';
import { formatGHS } from '../../../shared/js/utils/currency.js';
import { openSecurityPinSheet } from '../../../shared/js/components/securityPinSheet.js';
import { openFinancialAuthorizationSheet } from '../../../shared/js/components/financialAuthorizationSheet.js';
import { setSecurityPin, pinErrorMessage } from '../../../shared/js/services/securityPinService.js';
import {
    initiateTopupCharge,
    verifyTopupNow,
    topupErrorMessage,
    newIdempotencyKey
} from '../../../shared/js/services/topupService.js';

// Minimum top-up the UI will allow (mirrors the server-side MIN_TOPUP enforcement).
const MIN_TOPUP_GHS = PLATFORM_CONFIG?.minTopupGHS ?? 1;

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LOGIN_URL = 'login.html';

// ── Provider detection (Ghana prefixes) ───────────────────────────────────────
const PROVIDER_PREFIXES = {
    mtn:        ['024', '054', '055', '059', '025', '053'],
    telecel:    ['020', '050'],
    airteltigo: ['026', '056', '027', '057']
};

function detectProvider(phone) {
    let digits = phone.replace(/\D/g, '');
    if (digits.startsWith('233')) digits = '0' + digits.slice(3);
    else if (digits.length === 9 && !digits.startsWith('0')) digits = '0' + digits;
    const prefix = digits.slice(0, 3);
    for (const [provider, prefixes] of Object.entries(PROVIDER_PREFIXES)) {
        if (prefixes.includes(prefix)) return provider;
    }
    return null;
}

function normalisePhone(phone) {
    let d = phone.replace(/\D/g, '');
    if (d.startsWith('233')) d = '0' + d.slice(3);
    else if (d.length === 9 && !d.startsWith('0')) d = '0' + d;
    return d;
}

function maskPhone(phone) {
    const d = phone.replace(/\D/g, '');
    if (d.length < 4) return phone;
    return d.slice(0, -4).replace(/\d/g, '·') + d.slice(-4);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const balanceDisplay    = document.getElementById('balance-display');
const accountList       = document.getElementById('account-list');
const addAccountToggle  = document.getElementById('add-account-toggle');
const addAccountForm    = document.getElementById('add-account-form');
const addPhoneInput     = document.getElementById('add-phone-input');
const providerBadge     = document.getElementById('provider-badge');
const providerBadgeLogo = document.getElementById('provider-badge-logo');
const providerBadgeText = document.getElementById('provider-badge-text');
const addNicknameInput  = document.getElementById('add-nickname-input');
const addDefaultRow     = document.getElementById('add-default-row');
const addDefaultCheck   = document.getElementById('add-default-check');
const addCancelBtn      = document.getElementById('add-cancel-btn');
const addSaveBtn        = document.getElementById('add-save-btn');
const amountInput       = document.getElementById('amount-input');
const confirmBtn        = document.getElementById('confirm-btn');
const successOverlay    = document.getElementById('success-overlay');
const ssTxnRef          = document.getElementById('ss-txn-ref');
const ssCopyBtn         = document.getElementById('ss-copy-btn');
const ssItemAmount      = document.getElementById('ss-item-amount');
const ssTotalValue      = document.getElementById('ss-total-value');
const ssMethodLogo      = document.getElementById('ss-method-logo');
const ssMethodName      = document.getElementById('ss-method-name');
const ssItemSub         = document.getElementById('ss-item-sub');
const ssMethodAmount    = document.getElementById('ss-method-amount');
const ssCreditStatus    = document.getElementById('ss-credit-status');
const ssDownloadBtn     = document.getElementById('ss-download-btn');
const ssDoneBtn         = document.getElementById('ss-done-btn');
const ssCloseBtn        = document.getElementById('success-done-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let selectedAccount  = null;
let savedAccounts    = [];
let currentUid       = null;
let currentUserEmail = '';
let paymentRepo      = null;
let lastSuccessData  = null;
let currentBalance   = 0;   // live wallet balance — updated by the Firestore subscription

// Wallet-credit detection: set when a topup is submitted, cleared once the
// webhook lands and the balance rises by at least the expected amount.
let waitingForCredit = false;
let expectedCredit   = 0;
let preTopupBalance  = 0; // wallet balance snapshotted when Confirm is clicked

// Security PIN state — SERVER-written metadata mirrored from customers/{uid}
// (securityPinConfigured). null = customer doc not loaded yet. The client can
// only READ this flag (isSafeCustomerProfileUpdate excludes it), so it can't
// be forged from the frontend; real enforcement is server-side at charge time.
let pinConfigured = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
// Currency formatting centralised in shared/js/utils/currency.js (GHS).
const formatGHC = formatGHS;

// ── Render all accounts ───────────────────────────────────────────────────────
function renderAccounts() {
    accountList.innerHTML = '';

    if (!savedAccounts.length) {
        const empty = document.createElement('div');
        empty.className = 'accounts-empty';
        empty.innerHTML = `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" stroke="#ccc" stroke-width="1.7" stroke-linecap="round"/>
            <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" stroke="#ccc" stroke-width="1.7" stroke-linecap="round"/>
            <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" stroke="#ccc" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <p>No accounts yet. Add one below.</p>`;
        accountList.appendChild(empty);
        updateConfirmBtn();
        return;
    }

    savedAccounts.forEach(acc => {
        const meta = PROVIDER_META[acc.data.provider] || {};
        const card = document.createElement('button');
        card.className = 'account-card' + (selectedAccount === acc.id ? ' active' : '');
        card.dataset.id = acc.id;
        card.innerHTML = `
          <div class="account-logo-wrap">${meta.logo || ''}</div>
          <div class="account-info">
            <p class="account-phone">${esc(maskPhone(acc.data.phone))}</p>
            <p class="account-provider-label">${esc(meta.label || acc.data.provider)}</p>
          </div>
          ${acc.data.isDefault ? '<span class="account-default-badge">Default</span>' : ''}
          <div class="account-radio"></div>`;
        card.addEventListener('click', () => {
            selectedAccount = acc.id;
            document.querySelectorAll('.account-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            updateConfirmBtn();
        });
        accountList.appendChild(card);
    });

    // Auto-select default or first if no valid selection
    if (!selectedAccount || !savedAccounts.find(a => a.id === selectedAccount)) {
        const def = savedAccounts.find(a => a.data.isDefault) || savedAccounts[0];
        if (def) {
            selectedAccount = def.id;
            accountList.querySelector(`[data-id="${def.id}"]`)?.classList.add('active');
        }
    }

    updateConfirmBtn();
}

// ── Confirm button state ──────────────────────────────────────────────────────
function updateConfirmBtn() {
    const amount = parseFloat(amountInput.value);
    // A saved account is optional — users can pay by card/bank without one.
    // Enforce the platform minimum top-up client-side so users can't submit
    // zero/sub-minimum amounts (e.g. 0.001 rounding to GHS 0.00).
    const ready = Number.isFinite(amount) && amount >= MIN_TOPUP_GHS;
    confirmBtn.disabled = !ready;
    if (ready) {
        confirmBtn.textContent = `Top Up ${formatGHC(amount)}`;
    } else if (Number.isFinite(amount) && amount > 0 && amount < MIN_TOPUP_GHS) {
        confirmBtn.textContent = `Minimum ${formatGHC(MIN_TOPUP_GHS)}`;
    } else {
        confirmBtn.textContent = 'Confirm Top Up';
    }
}

// ── Quick amount buttons ──────────────────────────────────────────────────────
document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        amountInput.value = btn.dataset.amount;
        updateConfirmBtn();
    });
});

amountInput.addEventListener('input', () => {
    document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
    updateConfirmBtn();
});

// ── Add account form ──────────────────────────────────────────────────────────
addAccountToggle.addEventListener('click', () => {
    addAccountForm.classList.add('open');
    addAccountToggle.style.display = 'none';
    setTimeout(() => addPhoneInput.focus(), 50);
});

addCancelBtn.addEventListener('click', closeAddForm);

function closeAddForm() {
    addAccountForm.classList.remove('open');
    addAccountToggle.style.display = '';
    addPhoneInput.value     = '';
    addNicknameInput.value  = '';
    addDefaultCheck.checked = false;
    addDefaultRow.classList.remove('checked');
    providerBadge.className = 'provider-badge';
    providerBadgeLogo.innerHTML = '';
    providerBadgeText.textContent = '';
    addSaveBtn.disabled    = true;
    addSaveBtn.textContent = 'Save Account';
}

// Phone input → auto-detect provider
addPhoneInput.addEventListener('input', () => {
    const phone    = addPhoneInput.value.trim();
    const provider = detectProvider(phone);
    const meta     = provider ? PROVIDER_META[provider] : null;
    const digits   = phone.replace(/\D/g, '');

    if (digits.length >= 3) {
        providerBadge.classList.add('visible');
        if (meta) {
            providerBadge.classList.remove('undetected');
            providerBadgeLogo.innerHTML   = meta.logo;
            providerBadgeText.textContent = meta.label + ' detected';
        } else {
            providerBadge.classList.add('undetected');
            providerBadgeLogo.innerHTML   = '';
            providerBadgeText.textContent = 'Unknown network';
        }
    } else {
        providerBadge.className = 'provider-badge';
    }

    addSaveBtn.disabled = !(meta && digits.length >= 9);
});

// Default checkbox toggle
addDefaultRow.addEventListener('click', () => {
    addDefaultRow.classList.toggle('checked');
    addDefaultCheck.checked = addDefaultRow.classList.contains('checked');
});

// Save account
addSaveBtn.addEventListener('click', async () => {
    const rawPhone = addPhoneInput.value.trim();
    const provider = detectProvider(rawPhone);
    if (!provider) { showToast('Cannot detect provider. Check the number.', 'error'); return; }

    const phone = normalisePhone(rawPhone);
    addSaveBtn.disabled    = true;
    addSaveBtn.textContent = 'Saving…';

    try {
        await paymentRepo.addAccount(currentUid, {
            provider,
            phone,
            nickname:  addNicknameInput.value.trim(),
            isDefault: addDefaultRow.classList.contains('checked')
        });
        closeAddForm();
        showToast('Account added!', 'success');
    } catch (err) {
        console.error('Add account error:', err);
        showToast(err.message || 'Failed to save account.', 'error');
        addSaveBtn.disabled    = false;
        addSaveBtn.textContent = 'Save Account';
    }
});

// ── Confirm top up → Handy Hub Security PIN sheet ─────────────────────────────
// The internal payment experience starts here: pressing Top Up opens the
// Security PIN sheet (shared/js/components/securityPinSheet.js) on THIS page —
// no redirect, no OS keyboard. The PIN is then sent to the initiateTopupCharge
// Cloud Function, which verifies it server-side, validates and clamps the
// amount, generates the Paystack reference itself and records a pending intent
// bound to the authenticated UID before opening the charge.
//
// The legacy popup below (launchPaystackPopup) stays OFF permanently. It let the
// browser choose the amount, the reference and the metadata.userId that the
// webhook credited — three client-controlled inputs on a money path — and it
// showed a success receipt from Paystack's browser callback, before any webhook
// had confirmed anything. It is retained only as a reference for the Paystack
// SDK wiring. Do not re-enable it.
const USE_LEGACY_PAYSTACK_POPUP = false;

confirmBtn.addEventListener('click', async () => {
    const amount = parseFloat(amountInput.value);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_GHS) {
        showToast(`Minimum top-up is ${formatGHC(MIN_TOPUP_GHS)}.`, 'error');
        return;
    }

    if (USE_LEGACY_PAYSTACK_POPUP) { launchPaystackPopup(amount); return; }

    // Direct charge needs a destination handset. Previously the Paystack popup
    // collected this itself, so a customer with no saved account could still
    // pay; now the account IS the payment instrument. Say so plainly rather
    // than letting the server reject it after the PIN step.
    if (!selectedAccount) {
        showToast('Add a mobile money account first to top up.', 'error');
        document.getElementById('add-account-toggle')?.focus();
        return;
    }

    // ── Smart routing: the SYSTEM decides Enter vs Create from real backend
    // state — the customer is never asked to choose. pinConfigured mirrors the
    // live customer doc, so this stays SYNCHRONOUS: opening the sheet inside this
    // gesture is what lets the system keyboard appear instantly. Awaiting a read
    // here would push the sheet into a later task and cost the keyboard on iOS.
    if (pinConfigured !== null) {
        if (pinConfigured) openEnterPinFlow(amount);
        else               openCreatePinFlow(amount);
        return;
    }

    // Cold start only: the customer doc hasn't arrived yet. The keyboard can't be
    // raised from a post-await task, so don't pretend — resolve the flag, then
    // open. The entry is still tappable to raise it.
    try {
        const snap = await databaseService.getDocument('customers', currentUid);
        if (snap?.exists && snap.data?.securityPinConfigured) openEnterPinFlow(amount);
        else                                                  openCreatePinFlow(amount);
    } catch (_) {
        showToast('Unable to verify your PIN right now. Please try again.', 'error');
    }
});

// ── Enter-PIN flow (PIN already configured) ───────────────────────────────────
function openEnterPinFlow(amount) {
    // One key per attempt, reused across PIN retries within this sheet. A wrong
    // PIN never consumes it (the server claims the key only after the PIN
    // verifies), so retrying cannot be mistaken for a second top-up.
    const idempotencyKey = newIdempotencyKey();

    openSecurityPinSheet({
        mode:         'enter',
        title:        'Enter your PIN',
        message:      'Enter your 4-digit Handy Hub Security PIN to confirm this top-up. This is not your Mobile Money PIN.',
        context:      `Top-up · ${formatGHC(amount)}`,
        confirmLabel: 'Confirm Top Up',
        onConfirm: (pin, controls) => {
            // The PIN goes straight to initiateTopupCharge, which verifies it
            // server-side inside the trusted charge flow (never a standalone
            // verify endpoint — that would be a brute-force oracle). It is not
            // stored, logged or retained anywhere on this page.
            controls.setBusy(true);
            runTopupCharge(amount, pin, controls, idempotencyKey);
        },
        onForgot: (controls) => {
            controls.close('forgot');
            sessionStorage.setItem('pageTransitionDirection', 'forward');
            window.location.href = 'settings-security.html';
        },
        // Dismissing costs the user nothing: the amount and selected account
        // live on the page underneath and are left untouched.
    });
}

// ── First-time Create-PIN flow (no PIN configured yet) ────────────────────────
function openCreatePinFlow(amount) {
    openSecurityPinSheet({
        mode:    'create',
        context: `Top-up · ${formatGHC(amount)}`,
        onCreate: async (pin, controls) => {
            controls.setBusy(true);
            try {
                await setSecurityPin(pin);   // real create — scrypt-hashed server-side
                pinConfigured = true;
                showToast('Security PIN created.', 'success');
                // The PIN the customer just set authorises THIS top-up — never
                // ask them to re-enter it immediately. It is re-verified
                // server-side inside initiateTopupCharge regardless.
                runTopupCharge(amount, pin, controls, newIdempotencyKey());
            } catch (err) {
                if (String(err?.code || '').includes('already-exists')) {
                    // Metadata lagged behind the protected record — heal locally
                    // and continue through the Enter flow instead of failing.
                    pinConfigured = true;
                    controls.close('created');
                    showToast(pinErrorMessage(err), 'info');
                    openEnterPinFlow(amount);
                    return;
                }
                controls.showError(pinErrorMessage(err));
            }
        },
    });
}

// ── Authorization step — the PIN sheet MORPHS into this ───────────────────────
// The customer never leaves this page, and the sheet never leaves the screen:
// the Security PIN step hands its shell over and the content swaps in place, so
// this reads as one continuous financial journey rather than two unrelated
// modals. The entered amount and selected account sit untouched underneath.
//
// AUTHORITY: this screen NEVER decides that money arrived. It reflects
// topupIntents/{reference}.status, which only Cloud Functions can write and
// which flips to 'successful' inside the same transaction that credits the
// wallet. Paystack's browser callback is treated as a hint about the popup, not
// as proof of payment — so closing the tab mid-payment still settles correctly.
const AUTH_TIMEOUT_MS = 180_000;   // MoMo prompts can legitimately take minutes

// Guards against a second charge being opened while one is already in flight
// (double-tap, or Confirm pressed again behind the sheet).
let chargeInFlight = false;
let unsubIntent    = null;

function stopIntentWatch() {
    if (unsubIntent) { try { unsubIntent(); } catch {} unsubIntent = null; }
}

/**
 * Run the real top-up.
 *
 * Stays on the PIN sheet until the server has accepted the PIN and opened the
 * charge, so a wrong PIN is corrected in place instead of dead-ending the
 * customer in an authorization screen that can never succeed.
 */
async function runTopupCharge(amount, pin, controls, idempotencyKey) {
    if (chargeInFlight) return;
    chargeInFlight = true;

    let init;
    try {
        // Direct charge: the server needs to know WHICH handset to prompt. The
        // saved account is resolved server-side under the caller's own UID, so
        // the browser never gets to name a destination it doesn't own.
        init = await initiateTopupCharge({
            amount,
            pin,
            paymentMethodId: selectedAccount || null,
            idempotencyKey,
        });
    } catch (err) {
        chargeInFlight = false;
        // Recoverable, PIN-specific failures belong on the PIN step where the
        // customer can simply try again.
        controls.setBusy(false);
        controls.showError(topupErrorMessage(err));
        return;
    }

    // Charge is open upstream — hand the shell over to the authorization view.
    openAuthorizationView(amount, controls, init);
}

// ── Active payment confirmation ───────────────────────────────────────────────
// Polls verifyTopupNow while a charge is outstanding. The Firestore listener
// remains the primary signal — this is the second, faster path to the same
// truth, and both converge on one idempotent server-side settlement.
//
// Cadence: 2s for the first 30s (the window in which most MoMo approvals land),
// then 5s, capped at AUTH_TIMEOUT_MS. Terminal states stop it immediately.
let verifyPollTimer = null;

function stopVerifyPolling() {
    if (verifyPollTimer) { clearTimeout(verifyPollTimer); verifyPollTimer = null; }
}

function startVerifyPolling(reference, api, isSettled, markSettled, amount, init) {
    stopVerifyPolling();
    const startedAt = Date.now();
    let inFlight = false;

    const tick = async () => {
        if (isSettled()) return stopVerifyPolling();
        const elapsed = Date.now() - startedAt;
        if (elapsed > AUTH_TIMEOUT_MS) return stopVerifyPolling();

        // Never stack requests — a slow response must not queue another.
        if (!inFlight) {
            inFlight = true;
            try {
                const r = await verifyTopupNow(reference);

                if (r.credited === true || r.status === 'successful') {
                    // Terminal success. The listener may also fire; both are
                    // guarded by isSettled so the receipt shows exactly once.
                    if (!isSettled()) {
                        markSettled(true);
                        stopVerifyPolling();
                        stopIntentWatch();
                        chargeInFlight = false;
                        api.setState('confirmed');
                        setTimeout(() => {
                            api.close('confirmed');
                            showSuccess({
                                amount,
                                provider:    init?.provider,
                                phone:       init?.phone,
                                paystackRef: reference,
                            });
                            if (ssCreditStatus) {
                                ssCreditStatus.textContent = 'Wallet credited!';
                                ssCreditStatus.style.color = '#16a34a';
                            }
                            amountInput.value = '';
                            document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
                            updateConfirmBtn();
                        }, 900);
                    }
                    return;
                }

                if (r.status === 'failed' || r.status === 'abandoned' || r.status === 'initialization_failed') {
                    if (!isSettled()) {
                        markSettled(true);
                        stopVerifyPolling();
                        stopIntentWatch();
                        chargeInFlight = false;
                        api.setState('failed');
                    }
                    return;
                }

                // Still pending. Once the customer has approved, "waiting for
                // authorisation" is no longer true — say what is actually
                // happening instead of implying they still owe us an action.
                if (!isSettled() && elapsed > 6000 && api.getState?.() === 'waiting') {
                    api.setState('waiting', { hint: 'Confirming your payment…' });
                }
            } catch (err) {
                // A failed check is NOT a failed payment. Stay pending and try
                // again; the webhook is the backstop either way.
                console.warn('[topup] verify poll error:', err?.message || err);
            } finally {
                inFlight = false;
            }
        }

        const interval = (Date.now() - startedAt) < 30_000 ? 2_000 : 5_000;
        verifyPollTimer = setTimeout(tick, interval);
    };

    // First check quickly — some networks approve almost instantly.
    verifyPollTimer = setTimeout(tick, 1_500);
}

function openAuthorizationView(amount, controls, init) {
    const acc           = savedAccounts.find(a => a.id === selectedAccount) || null;
    const provider      = acc?.data?.provider || '';
    const providerLabel = PROVIDER_META[provider]?.label || provider || 'Mobile Money';
    const phone         = acc?.data?.phone ? maskPhone(acc.data.phone) : '';

    // Snapshot for the legacy balance-rise detector (secondary signal only).
    preTopupBalance = currentBalance;

    // The PIN step stops its idle timer, drops its listeners and wipes its
    // secrets, then gives up the shell — without closing it.
    controls.release();

    let timer    = null;
    let settled  = false;

    openFinancialAuthorizationSheet({
        sheet:    controls.sheet,        // ← morph this shell, don't open a second sheet
        state:    'waiting',
        amount:   formatGHC(amount),
        provider: providerLabel,
        phone,
        onCancel(api) {
            // Cancelling only closes OUR screen. It cannot cancel a charge that
            // is already with Paystack, so we never claim the payment stopped —
            // if it lands, the webhook still credits and history still shows it.
            clearTimeout(timer);
            stopVerifyPolling();
            stopIntentWatch();
            chargeInFlight = false;
            api.setState('cancelled');
            setTimeout(() => api.close('cancelled'), 650);
        },
        onRetry(api) {
            clearTimeout(timer);
            stopVerifyPolling();
            stopIntentWatch();
            chargeInFlight = false;
            api.close('retry');
            openEnterPinFlow(amount);    // amount survives — page state is intact
        },
        onClose() {
            clearTimeout(timer);
            stopVerifyPolling();
            stopIntentWatch();
            chargeInFlight = false;
        },
    }).then(async (api) => {
        // ── The authoritative signal: the server's own payment record ────────
        unsubIntent = databaseService.subscribeToDocument(
            'topupIntents', init.reference,
            (snap) => {
                if (!snap.exists || settled) return;
                const st = snap.data.status;

                if (st === 'successful' && snap.data.credited === true) {
                    settled = true;
                    clearTimeout(timer);
                    stopVerifyPolling();
                    stopIntentWatch();
                    chargeInFlight = false;
                    api.setState('confirmed');
                    setTimeout(() => {
                        api.close('confirmed');
                        showSuccess({
                            amount:      Number(snap.data.amountPesewas || 0) / 100,
                            provider:    snap.data.provider,
                            phone:       snap.data.phone,
                            paystackRef: init.reference,
                        });
                        if (ssCreditStatus) {
                            ssCreditStatus.textContent = 'Wallet credited!';
                            ssCreditStatus.style.color = '#16a34a';
                        }
                        amountInput.value = '';
                        document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
                        updateConfirmBtn();
                    }, 900);
                } else if (st === 'failed' || st === 'initialization_failed' || st === 'abandoned') {
                    settled = true;
                    clearTimeout(timer);
                    stopVerifyPolling();
                    stopIntentWatch();
                    chargeInFlight = false;
                    api.setState('failed');
                }
            },
            (err) => console.warn('[topup] intent listener error:', err?.message || err),
        );

        // ── No checkout to open ──────────────────────────────────────────────
        // The server already pushed the charge to the customer's handset via
        // Paystack's Charge API, so there is no Paystack window, no redirect and
        // no browser callback. This screen is ours end to end.
        //
        // Paystack's charge status is a UI hint only — never a credit signal.
        // The subscription above is the sole authority for success.
        if (init.chargeStatus === 'failed') {
            settled = true;
            stopIntentWatch();
            chargeInFlight = false;
            api.setState('failed');
            return;
        }

        // Surface the network's own wording when it sends any ("Dial *170#…").
        if (init.displayText) api.setState('waiting', { hint: init.displayText });

        if (init.chargeStatus === 'send_otp') {
            api.setState('waiting', {
                hint: init.displayText
                    || 'Your network sent you a code. Enter it on your phone to approve this payment.',
            });
        }

        // ── Active confirmation ──────────────────────────────────────────────
        // The Firestore listener above only fires once the WEBHOOK has landed,
        // and Paystack's mobile-money webhook routinely trails the customer's
        // approval by 30s–2min. Relying on it alone is what left the spinner
        // running long after the money had moved.
        //
        // So we also ASK. Each poll hands the server a reference; the server
        // checks ownership, reads the real status from Paystack, and credits via
        // the same idempotent path as the webhook. Whichever wins, money moves
        // once. Polling stops the moment either path reaches a terminal state.
        startVerifyPolling(init.reference, api, () => settled, (v) => { settled = v; }, amount, init);

        timer = setTimeout(() => {
            if (!settled && api.getState() !== 'confirmed') api.setState('timed_out');
        }, AUTH_TIMEOUT_MS);
    }).catch((err) => {
        // The sheet itself failed to open. Without this the in-flight guard
        // would stay latched and the customer could never retry on this page.
        console.error('[topup] authorization sheet failed:', err?.message || err);
        clearTimeout(timer);
        stopIntentWatch();
        chargeInFlight = false;
        showToast('Something went wrong showing the payment screen. Please try again.', 'error');
    });
}

// ── Legacy Paystack popup checkout (superseded — see flag above) ──────────────
async function launchPaystackPopup(amount) {
    // Snapshot balance before opening payment so we can detect the webhook credit later.
    preTopupBalance = currentBalance;

    // Account is optional — used only to attach MoMo details to the transaction record.
    // When paying by card or bank, no account is needed.
    const acc      = savedAccounts.find(a => a.id === selectedAccount) || null;
    const provider = acc?.data?.provider || null;
    const phone    = acc?.data?.phone    || null;
    const meta     = provider ? PROVIDER_META[provider] : null;
    let paymentFlowSettled = false;

    confirmBtn.disabled    = true;
    confirmBtn.textContent = 'Opening payment…';

    function resetBtn() {
        confirmBtn.disabled = false;
        updateConfirmBtn();
    }

    try {
        await initiatePayment({
            email:    currentUserEmail || `${currentUid}@handyhub.app`,
            amount,
            metadata: {
                // userId + userType are required by the Paystack webhook handler
                // (functions/financial/webhooks.js) to know which wallet to credit.
                userId:   currentUid,
                userType: 'customer',
                provider,
                phone,
                custom_fields: [
                    { display_name: 'Provider', variable_name: 'provider', value: meta?.label || provider },
                    { display_name: 'Phone',    variable_name: 'phone',    value: phone || '' }
                ]
            },
            onSuccess: async (response) => {
                if (paymentFlowSettled) return;
                paymentFlowSettled = true;
                confirmBtn.textContent = 'Processing…';

                // Write a pending transaction so the user sees immediate feedback.
                // The webhook (server-side) will upgrade it to 'successful' and
                // credit the wallet balance — no client-side balance mutation needed.
                try {
                    await paymentRepo.recordTopUp(currentUid, {
                        amount, provider, phone,
                        paystackRef: response.reference
                    });
                } catch (err) {
                    // Non-fatal: the webhook handles the authoritative wallet credit.
                    console.warn('[topup] Pending transaction record failed (non-fatal):', err.message);
                }

                showSuccess({ amount, provider, phone, paystackRef: response.reference });
                amountInput.value = '';
                document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));

                // Arm the credit-detection listener (clears itself once balance rises).
                expectedCredit   = amount;
                waitingForCredit = true;

                // Notify user immediately; final "wallet credited" confirmation arrives
                // via the Firestore subscription when the webhook has landed.
                createNotification({
                    receiverId: currentUid,
                    senderId:   currentUid,   // required by Firestore rule: senderId == auth.uid
                    type:       'Payments',
                    title:      'Payment Received',
                    message:    `GHS ${Number(amount).toFixed(2)}${meta?.label ? ' via ' + meta.label : ''} is being credited to your wallet.`,
                    actionUrl:  'transaction-history.html',
                    metadata:   { paystackRef: response.reference, amount, provider }
                }).catch(() => {}); // fire-and-forget — never block the UI

                resetBtn();
            },
            onClose: () => {
                if (paymentFlowSettled) return;
                paymentFlowSettled = true;
                resetBtn();
                showToast('Top up cancelled,', 'info');
            }
        });
        // Iframe open — button stays disabled until onSuccess or onClose fires
    } catch (err) {
        paymentFlowSettled = true;
        console.error('Paystack error:', err);
        showToast(err.message || 'Could not open payment. Try again.', 'error');
        resetBtn();
    }
}

// ── Success screen ────────────────────────────────────────────────────────────
function showSuccess({ amount, provider, phone, paystackRef }) {
    const meta   = PROVIDER_META[provider] || {};
    const fmtAmt = formatGHC(amount);
    lastSuccessData = { amount, provider, phone, paystackRef, meta };

    ssTxnRef.textContent      = paystackRef || '—';
    ssItemAmount.textContent  = fmtAmt;
    ssTotalValue.textContent  = fmtAmt;
    ssMethodLogo.innerHTML    = meta.logo || '';
    ssMethodName.textContent  = meta.label || provider;
    ssItemSub.textContent     = maskPhone(phone || '');
    ssMethodAmount.textContent = fmtAmt;

    successOverlay.classList.add('visible');
    successOverlay.setAttribute('aria-hidden', 'false');
}

function hideSuccess() {
    successOverlay.classList.remove('visible');
    successOverlay.setAttribute('aria-hidden', 'true');
}

ssCloseBtn.addEventListener('click', hideSuccess);
ssDoneBtn.addEventListener('click',  hideSuccess);

// Copy transaction ref
ssCopyBtn.addEventListener('click', () => {
    const ref = ssTxnRef.textContent;
    if (!ref || ref === '—') return;
    navigator.clipboard?.writeText(ref).then(() => {
        ssCopyBtn.textContent = 'Copied!';
        setTimeout(() => { ssCopyBtn.textContent = 'Copy'; }, 2000);
    }).catch(() => showToast('Could not copy. Please copy manually.', 'error'));
});

// Download receipt
ssDownloadBtn.addEventListener('click', () => {
    if (!lastSuccessData) return;
    const { amount, provider, phone, paystackRef, meta } = lastSuccessData;
    const date  = new Date().toLocaleString('en-GH', { dateStyle: 'full', timeStyle: 'short' });
    const lines = [
        '====================================',
        '         HANDY HUB RECEIPT          ',
        '====================================',
        `Date       : ${date}`,
        `Ref        : ${paystackRef || '—'}`,
        '------------------------------------',
        `Amount     : ${formatGHC(amount)}`,
        `Charges    : ${formatGHS(0)}`,
        `Total      : ${formatGHC(amount)}`,
        '------------------------------------',
        `Provider   : ${meta?.label || provider}`,
        `Phone      : ${phone || '—'}`,
        '====================================',
        '    Payment secured by Paystack     ',
        '====================================',
    ].join('\n');

    const blob = new Blob([lines], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `HH-topup-${paystackRef || Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
});

// ── Returning from the hosted Paystack page (redirect fallback) ───────────────
// The inline checkout keeps the customer here, but when it can't resume we send
// them to Paystack's hosted page and they come back via the Callback URL with
// ?reference= / ?trxref= appended.
//
// Their sheet is gone and this page has forgotten everything, so pick the
// payment back up from the SERVER's record. The query parameter is only a hint
// about WHICH intent to read — it is never treated as proof of payment, and a
// forged one resolves to an intent that either isn't theirs (rules deny the
// read) or isn't credited.
function resumeFromRedirect() {
    let ref = null;
    try {
        const q = new URLSearchParams(window.location.search);
        ref = q.get('reference') || q.get('trxref');
    } catch { /* malformed query string — nothing to resume */ }
    if (!ref) return;

    // Drop the parameters so a refresh doesn't replay this.
    try {
        const clean = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', clean);
    } catch { /* non-fatal */ }

    showToast('Checking your payment…', 'info');

    let done = false;
    const finish = () => { done = true; stopIntentWatch(); };

    unsubIntent = databaseService.subscribeToDocument(
        'topupIntents', ref,
        (snap) => {
            if (!snap.exists || done) return;
            const d = snap.data;
            if (d.status === 'successful' && d.credited === true) {
                finish();
                showSuccess({
                    amount:      Number(d.amountPesewas || 0) / 100,
                    provider:    d.provider,
                    phone:       d.phone,
                    paystackRef: ref,
                });
                if (ssCreditStatus) {
                    ssCreditStatus.textContent = 'Wallet credited!';
                    ssCreditStatus.style.color = '#16a34a';
                }
            } else if (d.status === 'failed' || d.status === 'abandoned' || d.status === 'initialization_failed') {
                finish();
                showToast('That payment did not go through. No money was taken.', 'error');
            }
            // 'pending' → the webhook hasn't landed yet. Say nothing and keep
            // listening; the live balance subscription also reflects the credit.
        },
        (err) => console.warn('[topup] resume listener error:', err?.message || err),
    );

    // Don't listen forever on a payment the customer abandoned.
    setTimeout(() => { if (!done) stopIntentWatch(); }, 120_000);
}

// ── Auth + data bootstrap ─────────────────────────────────────────────────────
let unsubAccounts = null;

const { services: { authService, databaseService } } = getAppContainer();

authService.subscribeToAuthState(user => {
    if (!user) { window.location.href = LOGIN_URL; return; }
    currentUid       = user.uid;
    currentUserEmail = user.email || '';
    paymentRepo      = createPaymentRepository({ databaseService });

    // Live wallet balance — also drives the webhook-credit detection.
    databaseService.subscribeToDocument('customers', user.uid, snap => {
        if (!snap.exists) return;

        const balance  = Number(snap.data.walletBalance  || 0);
        const inEscrow = Number(snap.data.escrowBalance   || 0);

        // Smart PIN routing input — kept live so the Top Up button always knows
        // whether to open Enter-PIN or first-time Create-PIN.
        pinConfigured = Boolean(snap.data.securityPinConfigured);

        // Keep module-level mirror so the confirm handler can snapshot it as a baseline.
        currentBalance = balance;

        if (balanceDisplay) {
            balanceDisplay.style.opacity    = '';
            balanceDisplay.style.fontStyle  = '';
            balanceDisplay.style.fontSize   = '';
            balanceDisplay.innerHTML = `<span class="balance-currency">GHS</span>${balance.toFixed(2)}`;
        }

        // Show escrow balance sub-note so customer understands why available balance
        // may be lower than expected after a booking hold.
        const noteEl = document.getElementById('balance-note');
        if (noteEl) {
            if (inEscrow > 0) {
                noteEl.innerHTML = `Available to spend &nbsp;·&nbsp; <span style="color:#f97316;font-weight:700;">${formatGHS(inEscrow)} in escrow</span>`;
            } else {
                noteEl.textContent = 'Available to spend';
            }
        }

        // ── Webhook credit detection ─────────────────────────────────────────
        if (waitingForCredit && balance >= preTopupBalance + expectedCredit * 0.95) {
            waitingForCredit = false;

            if (ssCreditStatus) {
                ssCreditStatus.textContent = 'Wallet credited!';
                ssCreditStatus.style.color = '#16a34a';
            }

            showToast(`${formatGHS(expectedCredit)} has been added to your wallet!`, 'success');
        }
    }, (err) => {
        console.warn('[topupPage] wallet listener error:', err);
    });

    // If we're back from Paystack's hosted page, pick the payment up from the
    // server's record rather than leaving the customer with no confirmation.
    resumeFromRedirect();

    // Live accounts
    if (unsubAccounts) unsubAccounts();
    unsubAccounts = paymentRepo.subscribeToAccounts(
        user.uid,
        records => {
            savedAccounts = records;
            renderAccounts();
        },
        err => console.error('Accounts error:', err)
    );
});
