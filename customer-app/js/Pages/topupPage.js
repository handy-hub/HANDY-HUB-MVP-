import '../../../shared/js/utils/global-app.js';
import { getAppContainer } from '../../../shared/js/app/container.js';
import {
    createPaymentRepository,
    PROVIDER_META
} from '../../../shared/js/data/repositories/paymentRepository.js';
import { initiatePayment } from '../../../shared/js/services/paystackService.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatGHC(n) {
    return 'GHC ' + Number(n).toFixed(2);
}

const TOAST_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none"><path d="M20 7L10.25 16.75L6 12.5" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8V13" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/><path d="M12 16.5V16.55" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/><path d="M10.29 3.86L1.82 18A2 2 0 0 0 3.53 21H20.47A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.9"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
};

function showToast(msg, type = 'error') {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || ''}</span><span>${msg}</span>`;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('toast-exit'); setTimeout(() => t.remove(), 320); }, 3000);
}

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
            <p class="account-phone">${maskPhone(acc.data.phone)}</p>
            <p class="account-provider-label">${meta.label || acc.data.provider}</p>
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
    const acc    = savedAccounts.find(a => a.id === selectedAccount);
    const ready  = !!acc && amount > 0;
    confirmBtn.disabled    = !ready;
    confirmBtn.textContent = ready
        ? `Top Up ${formatGHC(amount)}`
        : 'Confirm Top Up';
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
    if (!provider) { showToast('Cannot detect provider. Check the number.'); return; }

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
        showToast(err.message || 'Failed to save account.');
        addSaveBtn.disabled    = false;
        addSaveBtn.textContent = 'Save Account';
    }
});

// ── Confirm top up (Paystack flow) ────────────────────────────────────────────
confirmBtn.addEventListener('click', async () => {
    const amount = parseFloat(amountInput.value);
    const acc    = savedAccounts.find(a => a.id === selectedAccount);
    if (!acc || !amount || amount <= 0) return;

    const { provider, phone } = acc.data;
    const meta = PROVIDER_META[provider];

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
                custom_fields: [
                    { display_name: 'Provider', variable_name: 'provider', value: meta?.label || provider },
                    { display_name: 'Phone',    variable_name: 'phone',    value: phone || '' }
                ]
            },
            onSuccess: async (response) => {
                confirmBtn.textContent = 'Recording payment…';
                try {
                    await paymentRepo.recordTopUp(currentUid, {
                        amount, provider, phone,
                        paystackRef: response.reference
                    });
                    showSuccess({ amount, provider, phone, paystackRef: response.reference });
                    amountInput.value = '';
                    document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
                } catch (err) {
                    console.error('Record top-up error:', err);
                    showToast(`Payment received but wallet update failed. Quote ref ${response.reference} to support.`, 'error');
                } finally {
                    resetBtn();
                }
            },
            onClose: () => {
                resetBtn();
                showToast('Payment cancelled.', 'info');
            }
        });
        // Iframe open — button stays disabled until onSuccess or onClose fires
    } catch (err) {
        console.error('Paystack error:', err);
        showToast(err.message || 'Could not open payment. Try again.', 'error');
        resetBtn();
    }
});

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
    }).catch(() => showToast('Could not copy. Please copy manually.'));
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
        `Charges    : GHC 0.00`,
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

// ── Auth + data bootstrap ─────────────────────────────────────────────────────
let unsubAccounts = null;

const { services: { authService, databaseService } } = getAppContainer();

authService.subscribeToAuthState(user => {
    if (!user) { window.location.href = LOGIN_URL; return; }
    currentUid       = user.uid;
    currentUserEmail = user.email || '';
    paymentRepo      = createPaymentRepository({ databaseService });

    // Live wallet balance
    databaseService.subscribeToDocument('customers', user.uid, snap => {
        if (snap.exists && balanceDisplay) {
            balanceDisplay.innerHTML = `<span class="balance-currency">GHC</span>${Number(snap.data.walletBalance || 0).toFixed(2)}`;
        }
    });

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
