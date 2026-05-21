/**
 * Payment Methods Modal
 * Slide-up sheet showing saved MoMo accounts with add/delete/default controls.
 * Call initPaymentModal(uid, databaseService) once auth is confirmed.
 */
import {
    createPaymentRepository,
    PROVIDER_META,
    PROVIDER_NAMES
} from '../../../shared/js/data/repositories/paymentRepository.js';

// ── Inject required CSS into <head> once ─────────────────────────────────────
(function injectStyles() {
    if (document.getElementById('pmo-styles')) return;
    const s = document.createElement('style');
    s.id = 'pmo-styles';
    s.textContent = `
/* ── Overlay ── */
#pmo-overlay {
  position: fixed; inset: 0; z-index: 800;
  background: rgba(0,0,0,0);
  transition: background .3s;
  pointer-events: none;
}
#pmo-overlay.open {
  background: rgba(0,0,0,0.45);
  pointer-events: all;
}

/* ── Sheet ── */
#pmo-sheet {
  position: fixed; left: 0; right: 0; bottom: 0;
  max-width: 480px; margin: 0 auto;
  background: #fff;
  border-radius: 28px 28px 0 0;
  padding: 0 0 env(safe-area-inset-bottom, 16px);
  z-index: 801;
  transform: translateY(100%);
  transition: transform .38s cubic-bezier(0.22,1,0.36,1);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
}
#pmo-sheet.open { transform: translateY(0); }

/* ── Handle ── */
.pmo-handle {
  width: 38px; height: 4px;
  background: #e0e0e0;
  border-radius: 999px;
  margin: 14px auto 0;
  flex-shrink: 0;
}

/* ── Header ── */
.pmo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  flex-shrink: 0;
}
.pmo-title {
  font-size: 18px; font-weight: 800; color: #111; letter-spacing: -.3px;
}
.pmo-close {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: #f0f0f0;
  border: none; cursor: pointer; transition: background .15s;
}
.pmo-close:hover { background: #e0e0e0; }

/* ── Scroll Body ── */
.pmo-body {
  flex: 1; overflow-y: auto;
  padding: 0 20px 20px;
  scrollbar-width: none;
}
.pmo-body::-webkit-scrollbar { display: none; }

/* ── Section label ── */
.pmo-label {
  font-size: 11px; font-weight: 700; color: #aaa;
  text-transform: uppercase; letter-spacing: .8px;
  margin: 12px 0 10px;
}

/* ── Account row ── */
.pmo-account {
  display: flex; align-items: center; gap: 12px;
  padding: 13px 16px;
  border-radius: 14px;
  border: 1.5px solid #eee;
  margin-bottom: 8px;
  background: #fff;
  transition: border-color .15s;
}
.pmo-account:hover { border-color: #f5c0c0; }

.pmo-acc-logo {
  width: 40px; height: 40px;
  border-radius: 50%; overflow: hidden; flex-shrink: 0;
}
.pmo-acc-logo svg { width: 40px; height: 40px; }

.pmo-acc-info { flex: 1; min-width: 0; }
.pmo-acc-phone {
  font-size: 14px; font-weight: 700; color: #111; margin-bottom: 2px;
}
.pmo-acc-provider {
  font-size: 12px; color: #888;
}
.pmo-acc-nickname {
  font-size: 11px; color: #aaa; font-style: italic;
}

.pmo-default-badge {
  font-size: 10px; font-weight: 700; color: #730201;
  background: #ffe0e0; padding: 3px 9px; border-radius: 999px;
  flex-shrink: 0;
}

.pmo-acc-menu {
  position: relative; flex-shrink: 0;
}
.pmo-kebab {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; border: none; cursor: pointer;
  background: none; color: #aaa;
  transition: background .15s;
}
.pmo-kebab:hover { background: #f5f5f5; }

.pmo-dropdown {
  position: absolute; right: 0; top: 36px;
  background: #fff; border: 1.5px solid #eee;
  border-radius: 12px; min-width: 148px;
  box-shadow: 0 8px 24px rgba(0,0,0,.12);
  z-index: 10; overflow: hidden;
  display: none;
}
.pmo-dropdown.show { display: block; }

.pmo-drop-item {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: none; background: none; font-family: inherit;
  text-align: left; transition: background .12s; color: #111;
}
.pmo-drop-item:hover { background: #fafafa; }
.pmo-drop-item.danger { color: #c00; }
.pmo-drop-item.danger:hover { background: #fff5f5; }

/* ── Empty state ── */
.pmo-empty {
  text-align: center; padding: 24px 0 8px;
  color: #bbb; font-size: 13px; line-height: 1.6;
}
.pmo-empty-icon {
  width: 52px; height: 52px; background: #f5f5f5; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 12px;
}

/* ── Add button ── */
.pmo-add-btn {
  width: 100%; padding: 14px;
  border: 2px dashed #ddd;
  border-radius: 14px; background: none;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  font-size: 14px; font-weight: 700; color: #730201;
  cursor: pointer; transition: border-color .15s, background .15s;
  margin-top: 4px; font-family: inherit;
}
.pmo-add-btn:hover { border-color: #730201; background: #fff5f5; }

/* ── Add Account Form ── */
.pmo-form { margin-top: 6px; }

.pmo-provider-grid {
  display: grid; grid-template-columns: repeat(3,1fr); gap: 8px;
  margin-bottom: 16px;
}
.pmo-prov-btn {
  display: flex; flex-direction: column; align-items: center; gap: 7px;
  padding: 12px 6px 10px;
  border: 2px solid #eee; border-radius: 14px; background: #fff;
  cursor: pointer; transition: border-color .15s, background .15s;
  font-family: inherit;
}
.pmo-prov-btn:hover    { border-color: #f5c0c0; background: #fff8f8; }
.pmo-prov-btn.selected { border-color: #730201; background: #fff5f5; }
.pmo-prov-logo { width: 38px; height: 38px; }
.pmo-prov-logo svg { width: 38px; height: 38px; }
.pmo-prov-name { font-size: 10px; font-weight: 700; color: #444; text-align: center; line-height: 1.3; }
.pmo-prov-btn.selected .pmo-prov-name { color: #730201; }

.pmo-field {
  margin-bottom: 12px;
}
.pmo-field label {
  display: block; font-size: 12px; font-weight: 700; color: #555; margin-bottom: 5px;
}
.pmo-field input {
  width: 100%; padding: 12px 14px;
  border: 1.5px solid #eee; border-radius: 12px;
  font-size: 15px; font-family: inherit; outline: none;
  transition: border-color .15s; color: #111; background: #fff;
}
.pmo-field input:focus { border-color: #730201; }

.pmo-check-row {
  display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
}
.pmo-check-row input[type=checkbox] { width: 16px; height: 16px; accent-color: #730201; }
.pmo-check-row label { font-size: 13px; color: #555; cursor: pointer; }

.pmo-form-actions {
  display: flex; gap: 10px;
}
.pmo-cancel-btn {
  flex: 1; padding: 13px;
  border: 1.5px solid #eee; border-radius: 12px;
  font-size: 14px; font-weight: 700; color: #888;
  background: #fff; cursor: pointer; font-family: inherit;
  transition: background .15s;
}
.pmo-cancel-btn:hover { background: #f5f5f5; }
.pmo-save-btn {
  flex: 2; padding: 13px;
  background: #730201; color: #fff; border: none;
  border-radius: 12px; font-size: 14px; font-weight: 700;
  cursor: pointer; font-family: inherit;
  transition: background .15s, opacity .15s;
}
.pmo-save-btn:disabled { opacity: .45; cursor: not-allowed; }
.pmo-save-btn:not(:disabled):hover { background: #a00303; }

/* ── Security note ── */
.pmo-security {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 11.5px; color: #bbb; padding: 14px 0 4px;
  border-top: 1px solid #f5f5f5; margin-top: 12px;
}

/* ── Dark theme ── */
[data-theme="dark"] #pmo-sheet { background: #1a1a1a; }
[data-theme="dark"] .pmo-handle { background: #333; }
[data-theme="dark"] .pmo-title  { color: #f0f0f0; }
[data-theme="dark"] .pmo-close  { background: #252525; }
[data-theme="dark"] .pmo-close:hover { background: #333; }
[data-theme="dark"] .pmo-close svg path { stroke: #ccc; }
[data-theme="dark"] .pmo-label  { color: #555; }
[data-theme="dark"] .pmo-account { background: #222; border-color: #2a2a2a; }
[data-theme="dark"] .pmo-account:hover { border-color: #730201; }
[data-theme="dark"] .pmo-acc-phone { color: #f0f0f0; }
[data-theme="dark"] .pmo-acc-provider { color: #888; }
[data-theme="dark"] .pmo-dropdown { background: #222; border-color: #333; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
[data-theme="dark"] .pmo-drop-item { color: #e0e0e0; }
[data-theme="dark"] .pmo-drop-item:hover { background: #2a2a2a; }
[data-theme="dark"] .pmo-drop-item.danger { color: #ff6b6b; }
[data-theme="dark"] .pmo-drop-item.danger:hover { background: #1e1010; }
[data-theme="dark"] .pmo-add-btn { border-color: #333; color: #ff6b6b; }
[data-theme="dark"] .pmo-add-btn:hover { border-color: #730201; background: #1e1010; }
[data-theme="dark"] .pmo-prov-btn { background: #222; border-color: #2a2a2a; }
[data-theme="dark"] .pmo-prov-btn:hover    { background: #2a1a1a; border-color: #a00303; }
[data-theme="dark"] .pmo-prov-btn.selected { background: #1e1010; border-color: #730201; }
[data-theme="dark"] .pmo-prov-name { color: #bbb; }
[data-theme="dark"] .pmo-field label { color: #888; }
[data-theme="dark"] .pmo-field input { background: #222; border-color: #333; color: #f0f0f0; }
[data-theme="dark"] .pmo-field input:focus { border-color: #730201; }
[data-theme="dark"] .pmo-check-row label { color: #888; }
[data-theme="dark"] .pmo-security { color: #555; border-top-color: #222; }
[data-theme="dark"] .pmo-empty-icon { background: #252525; }
`;
    document.head.appendChild(s);
})();

// ── Build modal HTML once ─────────────────────────────────────────────────────
function buildModalHTML() {
    if (document.getElementById('pmo-overlay')) return; // already built

    document.body.insertAdjacentHTML('beforeend', `
      <div id="pmo-overlay" aria-hidden="true"></div>

      <div id="pmo-sheet" role="dialog" aria-modal="true" aria-label="Payment Methods" aria-hidden="true">
        <div class="pmo-handle"></div>

        <div class="pmo-header">
          <h2 class="pmo-title">Payment Methods</h2>
          <button class="pmo-close" id="pmo-close-btn" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="#555" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="pmo-body" id="pmo-body">
          <!-- Accounts section -->
          <p class="pmo-label">Saved Accounts</p>
          <div id="pmo-accounts-list"></div>

          <!-- Add button -->
          <button class="pmo-add-btn" id="pmo-add-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="#730201" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
            Add New Account
          </button>

          <!-- Add form (hidden initially) -->
          <div class="pmo-form" id="pmo-form" hidden>
            <p class="pmo-label" style="margin-top:16px">Choose Provider</p>
            <div class="pmo-provider-grid" id="pmo-prov-grid">
              ${Object.entries(PROVIDER_META).map(([key, m]) => `
                <button class="pmo-prov-btn" data-provider="${key}" type="button">
                  <div class="pmo-prov-logo">${m.logo}</div>
                  <span class="pmo-prov-name">${m.label}</span>
                </button>`).join('')}
            </div>

            <div class="pmo-field">
              <label for="pmo-phone">Phone Number</label>
              <input type="tel" id="pmo-phone" placeholder="e.g. 0244 123 456" inputmode="tel" maxlength="15"/>
            </div>

            <div class="pmo-field">
              <label for="pmo-nickname">Nickname <span style="font-weight:400;color:#bbb">(optional)</span></label>
              <input type="text" id="pmo-nickname" placeholder="e.g. My MTN" maxlength="30"/>
            </div>

            <div class="pmo-check-row">
              <input type="checkbox" id="pmo-default"/>
              <label for="pmo-default">Set as default account</label>
            </div>

            <div class="pmo-form-actions">
              <button class="pmo-cancel-btn" id="pmo-cancel-btn" type="button">Cancel</button>
              <button class="pmo-save-btn"   id="pmo-save-btn"   type="button" disabled>Save Account</button>
            </div>
          </div>

          <!-- Security -->
          <div class="pmo-security">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="#bbb" stroke-width="1.7"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#bbb" stroke-width="1.7" stroke-linecap="round"/>
            </svg>
            Your payment info is secure and encrypted
          </div>
        </div>
      </div>
    `);
}

// ── Main export ───────────────────────────────────────────────────────────────
export function initPaymentModal(uid, databaseService) {
    buildModalHTML();

    const overlay       = document.getElementById('pmo-overlay');
    const sheet         = document.getElementById('pmo-sheet');
    const closeBtn      = document.getElementById('pmo-close-btn');
    const accountsList  = document.getElementById('pmo-accounts-list');
    const addBtn        = document.getElementById('pmo-add-btn');
    const form          = document.getElementById('pmo-form');
    const provGrid      = document.getElementById('pmo-prov-grid');
    const phoneInput    = document.getElementById('pmo-phone');
    const nicknameInput = document.getElementById('pmo-nickname');
    const defaultCheck  = document.getElementById('pmo-default');
    const cancelBtn     = document.getElementById('pmo-cancel-btn');
    const saveBtn       = document.getElementById('pmo-save-btn');

    const paymentRepo = createPaymentRepository({ databaseService });
    let accounts      = [];
    let formProvider  = null;
    let openDropdownId = null;
    let unsubAccounts = null;

    // ── Open / close ──────────────────────────────────────────────────────────
    function openModal() {
        overlay.classList.add('open');
        sheet.classList.add('open');
        sheet.setAttribute('aria-hidden', 'false');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
    }

    function closeModal() {
        overlay.classList.remove('open');
        sheet.classList.remove('open');
        sheet.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        hideForm();
        closeAllDropdowns();
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);

    // Expose open function via trigger elements
    document.querySelectorAll('[data-open-payments]').forEach(el => {
        el.addEventListener('click', e => { e.preventDefault(); openModal(); });
    });

    // ── Render accounts list ──────────────────────────────────────────────────
    function renderAccounts() {
        accountsList.innerHTML = '';
        const visible = accounts.filter(a => !a.data.deleted);

        if (!visible.length) {
            accountsList.innerHTML = `
              <div class="pmo-empty">
                <div class="pmo-empty-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <rect x="1" y="4" width="22" height="16" rx="2" stroke="#bbb" stroke-width="1.7"/>
                    <path d="M1 10h22" stroke="#bbb" stroke-width="1.7"/>
                  </svg>
                </div>
                No saved accounts yet.<br/>Add one below to get started.
              </div>`;
            return;
        }

        visible.forEach(acc => {
            const meta = PROVIDER_META[acc.data.provider] || {};
            const row  = document.createElement('div');
            row.className = 'pmo-account';
            row.dataset.id = acc.id;
            row.innerHTML = `
              <div class="pmo-acc-logo">${meta.logo || ''}</div>
              <div class="pmo-acc-info">
                <p class="pmo-acc-phone">${acc.data.phone}</p>
                <p class="pmo-acc-provider">${PROVIDER_NAMES[acc.data.provider] || acc.data.provider}</p>
                ${acc.data.nickname ? `<p class="pmo-acc-nickname">${acc.data.nickname}</p>` : ''}
              </div>
              ${acc.data.isDefault ? '<span class="pmo-default-badge">Default</span>' : ''}
              <div class="pmo-acc-menu">
                <button class="pmo-kebab" data-id="${acc.id}" aria-label="Options" type="button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="5"  r="1.2" fill="#aaa"/>
                    <circle cx="12" cy="12" r="1.2" fill="#aaa"/>
                    <circle cx="12" cy="19" r="1.2" fill="#aaa"/>
                  </svg>
                </button>
                <div class="pmo-dropdown" id="drop-${acc.id}">
                  ${!acc.data.isDefault ? `
                    <button class="pmo-drop-item" data-action="default" data-id="${acc.id}">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z"
                              stroke="#555" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      Set as Default
                    </button>` : ''}
                  <button class="pmo-drop-item danger" data-action="delete" data-id="${acc.id}">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#c00" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Remove
                  </button>
                </div>
              </div>`;
            accountsList.appendChild(row);
        });

        // Kebab toggle
        accountsList.querySelectorAll('.pmo-kebab').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const id   = btn.dataset.id;
                const drop = document.getElementById('drop-' + id);
                const isOpen = drop.classList.contains('show');
                closeAllDropdowns();
                if (!isOpen) { drop.classList.add('show'); openDropdownId = id; }
            });
        });

        // Dropdown actions
        accountsList.querySelectorAll('.pmo-drop-item').forEach(item => {
            item.addEventListener('click', async e => {
                e.stopPropagation();
                const { action, id } = item.dataset;
                closeAllDropdowns();

                if (action === 'delete') {
                    if (!confirm('Remove this account?')) return;
                    try { await paymentRepo.deleteAccount(uid, id); }
                    catch (err) { console.error(err); }
                } else if (action === 'default') {
                    try { await paymentRepo.setDefaultAccount(uid, id); }
                    catch (err) { console.error(err); }
                }
            });
        });
    }

    function closeAllDropdowns() {
        document.querySelectorAll('.pmo-dropdown.show').forEach(d => d.classList.remove('show'));
        openDropdownId = null;
    }

    document.addEventListener('click', e => {
        if (openDropdownId && !e.target.closest('.pmo-acc-menu')) closeAllDropdowns();
    });

    // ── Add account form ──────────────────────────────────────────────────────
    function showForm() {
        addBtn.style.display  = 'none';
        form.hidden = false;
        formProvider = null;
        phoneInput.value    = '';
        nicknameInput.value = '';
        defaultCheck.checked = !accounts.filter(a => !a.data.deleted).length;
        saveBtn.disabled = true;
    }

    function hideForm() {
        form.hidden = true;
        addBtn.style.display = '';
        formProvider = null;
        provGrid.querySelectorAll('.pmo-prov-btn').forEach(b => b.classList.remove('selected'));
        saveBtn.disabled = true;
    }

    addBtn.addEventListener('click', showForm);
    cancelBtn.addEventListener('click', hideForm);

    provGrid.addEventListener('click', e => {
        const btn = e.target.closest('.pmo-prov-btn[data-provider]');
        if (!btn) return;
        formProvider = btn.dataset.provider;
        provGrid.querySelectorAll('.pmo-prov-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        validateForm();
    });

    function validatePhone(v) {
        return /^[0-9+\s\-()]{7,15}$/.test(v.trim());
    }

    function validateForm() {
        saveBtn.disabled = !(formProvider && validatePhone(phoneInput.value));
    }

    phoneInput.addEventListener('input', validateForm);

    saveBtn.addEventListener('click', async () => {
        if (!formProvider || !validatePhone(phoneInput.value)) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            await paymentRepo.addAccount(uid, {
                provider:  formProvider,
                phone:     phoneInput.value.trim(),
                nickname:  nicknameInput.value.trim(),
                isDefault: defaultCheck.checked
            });
            hideForm();
        } catch (err) {
            console.error('Save account error:', err);
            saveBtn.textContent = 'Save Account';
            saveBtn.disabled = false;
        }
    });

    // ── Live subscription ─────────────────────────────────────────────────────
    if (unsubAccounts) unsubAccounts();
    unsubAccounts = paymentRepo.subscribeToAccounts(
        uid,
        records => { accounts = records; renderAccounts(); },
        err => console.error('Accounts sub error:', err)
    );

    // ── Public API ─────────────────────────────────────────────────────────────
    return { open: openModal, close: closeModal };
}
