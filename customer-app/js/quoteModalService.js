// quoteModalService.js
// System-wide quote approval modal for the customer app.
// Initialised once per page session from authInit.js.
// Fires automatically whenever the customer has a booking in 'quoted' status.

import {
    collection, query, where, onSnapshot, doc, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { firebaseDb, firebaseApp }
    from '../../shared/js/backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION }
    from '../../shared/js/config/appConfig.js';

// ── Module state ──────────────────────────────────────────────────────────────
let _uid      = null;
let _unsub    = null;
let _isOpen   = false;
let _activeId = null;
let _fnInst   = null;

// bookingIds the user explicitly dismissed this session — won't re-open until refresh
const _dismissed = new Set();

function _fn() {
    if (!_fnInst) _fnInst = getFunctions(firebaseApp, FUNCTIONS_REGION);
    return _fnInst;
}

function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmt(n) { return Number(n || 0).toFixed(2); }

// ── DOM ───────────────────────────────────────────────────────────────────────
const ROOT_ID = 'hh-qm-root';

function _ensureDOM() {
    if (document.getElementById(ROOT_ID)) return;

    const style = document.createElement('style');
    style.id = 'hh-qm-css';
    style.textContent = `
        #hh-qm-overlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:none;align-items:flex-end;justify-content:center;font-family:'DM Sans',system-ui,sans-serif}
        #hh-qm-overlay.open{display:flex}
        #hh-qm-sheet{width:100%;max-width:430px;background:var(--surface,#fff);border-radius:20px 20px 0 0;max-height:92dvh;overflow-y:auto;transform:translateY(102%);transition:transform .32s cubic-bezier(.32,.72,0,1)}
        #hh-qm-overlay.open #hh-qm-sheet{transform:translateY(0)}
        .hh-qm-drag{display:block;width:36px;height:4px;border-radius:2px;background:rgba(0,0,0,.12);margin:10px auto 0}
        .hh-qm-wrap{padding:16px 16px 44px}
        .hh-qm-hdr{display:flex;align-items:center;gap:12px;margin-bottom:6px}
        .hh-qm-av{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#730201,#c04040);display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:800;flex-shrink:0;overflow:hidden}
        .hh-qm-av img{width:100%;height:100%;object-fit:cover}
        .hh-qm-name{font-size:15px;font-weight:800;color:var(--text-dark,#111);margin:0 0 2px}
        .hh-qm-svc{font-size:12px;color:var(--text-mid,#666);margin:0}
        .hh-qm-x{width:30px;height:30px;border:none;background:var(--surface-3,#f3f3f3);border-radius:50%;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-mid,#666);flex-shrink:0;margin-left:auto}
        .hh-qm-badge{background:#fff8f0;border:1px solid #fed7aa;border-radius:10px;padding:7px 12px;font-size:12px;color:#c2410c;font-weight:600;margin:10px 0 14px;display:flex;align-items:center;gap:6px}
        .hh-qm-card{background:var(--surface-2,#f7f7f7);border-radius:14px;padding:14px;margin-bottom:12px}
        .hh-qm-clbl{font-size:10px;font-weight:700;color:var(--text-light,#999);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
        .hh-qm-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:4px 0;font-size:13px}
        .hh-qm-rl{color:var(--text-mid,#666)}
        .hh-qm-rv{font-weight:700;color:var(--text-dark,#111);text-align:right}
        .hh-qm-div{border:none;border-top:1px solid var(--border,#e8e8e8);margin:8px 0}
        .hh-qm-tot{display:flex;justify-content:space-between;align-items:center;padding-top:2px}
        .hh-qm-tl{font-size:14px;font-weight:800;color:var(--text-dark,#111)}
        .hh-qm-tv{font-size:20px;font-weight:800;color:#730201}
        .hh-qm-mats{margin:3px 0 4px 10px}
        .hh-qm-mrow{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-light,#999);padding:2px 0}
        .hh-qm-note{background:#fffbf0;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#78350f;line-height:1.5}
        .hh-qm-escrow{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;display:flex;gap:8px;align-items:flex-start;margin-bottom:18px;font-size:12px;color:#166534;line-height:1.5}
        .hh-qm-approve{width:100%;height:50px;border-radius:14px;border:none;background:#730201;color:#fff;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:8px;transition:opacity .15s}
        .hh-qm-approve:disabled{opacity:.55;cursor:default}
        .hh-qm-reject{width:100%;height:42px;border-radius:12px;border:1.5px solid var(--border,#e8e8e8);background:none;font-family:inherit;font-size:13px;font-weight:700;color:var(--text-mid,#666);cursor:pointer}
        .hh-qm-loading{display:flex;justify-content:center;align-items:center;gap:10px;padding:52px 16px;color:var(--text-light,#999);font-size:13px}
        .hh-qm-spin{width:26px;height:26px;border:3px solid var(--border,#e8e8e8);border-top-color:#730201;border-radius:50%;animation:hh-spin .8s linear infinite;flex-shrink:0}
        .hh-qm-inline-err{background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 12px;font-size:12px;color:#b91c1c;margin-bottom:12px;line-height:1.4}
        @keyframes hh-spin{to{transform:rotate(360deg)}}
        #hh-qm-rj-overlay{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.5);display:none;align-items:flex-end;justify-content:center;font-family:'DM Sans',system-ui,sans-serif}
        #hh-qm-rj-overlay.open{display:flex}
        #hh-qm-rj-sheet{width:100%;max-width:430px;background:var(--surface,#fff);border-radius:20px 20px 0 0;padding:16px 16px 44px}
        .hh-qm-rj-drag{display:block;width:36px;height:4px;border-radius:2px;background:rgba(0,0,0,.12);margin:0 auto 16px}
        .hh-qm-rj-title{font-size:15px;font-weight:800;color:var(--text-dark,#111);margin-bottom:4px}
        .hh-qm-rj-sub{font-size:12px;color:var(--text-light,#999);margin-bottom:14px;line-height:1.5}
        .hh-qm-rj-ta{width:100%;min-height:72px;border:1.5px solid var(--border,#e8e8e8);border-radius:10px;padding:10px 12px;font-family:inherit;font-size:16px;color:var(--text-dark,#111);background:var(--surface,#fff);resize:none;outline:none;box-sizing:border-box;margin-bottom:12px}
        .hh-qm-rj-ta:focus{border-color:#730201}
        .hh-qm-rj-confirm{width:100%;height:44px;border-radius:12px;border:none;background:#ef4444;color:#fff;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;margin-bottom:8px;transition:opacity .15s}
        .hh-qm-rj-confirm:disabled{opacity:.55;cursor:default}
        .hh-qm-rj-cancel{width:100%;height:38px;border-radius:12px;border:1.5px solid var(--border,#e8e8e8);background:none;font-family:inherit;font-size:13px;font-weight:700;color:var(--text-mid,#666);cursor:pointer}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
        <div id="hh-qm-overlay" role="presentation" aria-hidden="true">
            <div id="hh-qm-sheet" role="dialog" aria-modal="true" aria-label="Review Artisan Quote">
                <span class="hh-qm-drag" aria-hidden="true"></span>
                <div id="hh-qm-body" class="hh-qm-wrap">
                    <div class="hh-qm-loading"><div class="hh-qm-spin"></div>Loading quote…</div>
                </div>
            </div>
        </div>
        <div id="hh-qm-rj-overlay" role="presentation" aria-hidden="true">
            <div id="hh-qm-rj-sheet">
                <span class="hh-qm-rj-drag" aria-hidden="true"></span>
                <p class="hh-qm-rj-title">Reject this quote?</p>
                <p class="hh-qm-rj-sub">The artisan will be notified and can send a revised quote.</p>
                <textarea id="hh-qm-rj-reason" class="hh-qm-rj-ta" placeholder="Optional: reason for rejection…" maxlength="300"></textarea>
                <button class="hh-qm-rj-confirm" id="hh-qm-rj-confirm">Reject Quote</button>
                <button class="hh-qm-rj-cancel"  id="hh-qm-rj-cancel">Cancel</button>
            </div>
        </div>`;
    document.body.appendChild(root);

    document.getElementById('hh-qm-overlay').addEventListener('click', e => {
        if (e.target.id === 'hh-qm-overlay') _dismiss();
    });
    document.getElementById('hh-qm-rj-overlay').addEventListener('click', e => {
        if (e.target.id === 'hh-qm-rj-overlay') _closeReject();
    });
    document.getElementById('hh-qm-rj-cancel').addEventListener('click', _closeReject);
    document.getElementById('hh-qm-rj-confirm').addEventListener('click', _confirmReject);
}

// ── Open / close ──────────────────────────────────────────────────────────────
function _openModal(bookingId) {
    if (_isOpen && _activeId === bookingId) return;
    if (_isOnQuoteApprovalPage(bookingId)) return;

    _activeId = bookingId;
    _isOpen   = true;
    _ensureDOM();

    const body = document.getElementById('hh-qm-body');
    if (body) body.innerHTML = '<div class="hh-qm-loading"><div class="hh-qm-spin"></div>Loading quote…</div>';

    const ov = document.getElementById('hh-qm-overlay');
    if (ov) {
        ov.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => ov.classList.add('open'));
    }

    _loadAndRender(bookingId);
}

function _closeModal() {
    _isOpen   = false;
    _activeId = null;
    const ov = document.getElementById('hh-qm-overlay');
    if (ov) { ov.classList.remove('open'); ov.setAttribute('aria-hidden', 'true'); }
}

function _dismiss() {
    if (_activeId) _dismissed.add(_activeId);
    _closeModal();
}

function _isOnQuoteApprovalPage(bookingId) {
    return window.location.pathname.includes('quote-approval') &&
        new URLSearchParams(window.location.search).get('bookingId') === bookingId;
}

// ── Load booking + render quote ───────────────────────────────────────────────
async function _loadAndRender(bookingId) {
    try {
        const snap = await getDoc(doc(firebaseDb, 'bookings', bookingId));
        if (!snap.exists()) throw new Error('Booking not found.');
        _renderQuote({ id: bookingId, ...snap.data() });
    } catch (err) {
        const body = document.getElementById('hh-qm-body');
        if (!body) return;
        body.innerHTML = `
            <div class="hh-qm-wrap" style="text-align:center;padding:52px 16px">
                <p style="font-size:15px;font-weight:800;color:var(--text-dark,#111);margin:0 0 8px">Could not load quote</p>
                <p style="font-size:13px;color:var(--text-light,#999)">${_esc(err.message)}</p>
            </div>`;
    }
}

function _renderQuote(b) {
    const body = document.getElementById('hh-qm-body');
    if (!body) return;

    const name     = b.artisanName || 'Your Artisan';
    const initials = name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    const service  = b.serviceType || b.service || 'Service Job';
    const labour   = Number(b.labourCost    || 0);
    const matsCost = Number(b.materialsCost || 0);
    const total    = Number(b.jobQuote      || labour + matsCost);
    const hasMats  = b.hasMaterials && Array.isArray(b.materials) && b.materials.length > 0;

    const matRows = hasMats
        ? b.materials.map(m =>
            `<div class="hh-qm-mrow">
                <span>${_esc(m.name)} × ${m.qty}</span>
                <span>GHS ${_fmt(m.total != null ? m.total : m.qty * m.unitPrice)}</span>
            </div>`
        ).join('') : '';

    const matSection = hasMats ? `
        <div class="hh-qm-row">
            <span class="hh-qm-rl">Materials</span>
            <span class="hh-qm-rv">GHS ${_fmt(matsCost)}</span>
        </div>
        <div class="hh-qm-mats">${matRows}</div>` : '';

    const noteHTML = b.quoteNote
        ? `<div class="hh-qm-note"><strong>Note from artisan:</strong><br>${_esc(b.quoteNote)}</div>` : '';

    const avContent = b.artisanPhoto
        ? `<img src="${_esc(b.artisanPhoto)}" alt="${_esc(name)}" />` : initials;

    body.innerHTML = `
        <div class="hh-qm-hdr">
            <div class="hh-qm-av">${avContent}</div>
            <div style="flex:1;min-width:0">
                <p class="hh-qm-name">${_esc(name)}</p>
                <p class="hh-qm-svc">${_esc(service)}</p>
            </div>
            <button class="hh-qm-x" id="hh-qm-x-btn" aria-label="Dismiss">✕</button>
        </div>
        <div class="hh-qm-badge">💰 New quote — review before your artisan heads over</div>
        <div class="hh-qm-card">
            <div class="hh-qm-clbl">Quote Breakdown</div>
            <div class="hh-qm-row"><span class="hh-qm-rl">Labour</span><span class="hh-qm-rv">GHS ${_fmt(labour)}</span></div>
            ${matSection}
            <hr class="hh-qm-div" />
            <div class="hh-qm-tot"><span class="hh-qm-tl">Total</span><span class="hh-qm-tv">GHS ${_fmt(total)}</span></div>
        </div>
        ${noteHTML}
        <div class="hh-qm-escrow">
            <span style="font-size:16px;flex-shrink:0">🔒</span>
            <span>Payment is held in escrow and only released after you confirm the job is complete.</span>
        </div>
        <button class="hh-qm-approve" id="hh-qm-approve-btn">Approve &amp; Pay GHS ${_fmt(total)}</button>
        <button class="hh-qm-reject"  id="hh-qm-reject-btn">Reject Quote</button>`;

    document.getElementById('hh-qm-x-btn').addEventListener('click', _dismiss);
    document.getElementById('hh-qm-approve-btn').addEventListener('click', () => _approve(b.id, total));
    document.getElementById('hh-qm-reject-btn').addEventListener('click', _openReject);
}

// ── Approve ───────────────────────────────────────────────────────────────────
async function _approve(bookingId, total) {
    const btn = document.getElementById('hh-qm-approve-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

    try {
        await httpsCallable(_fn(), 'approveJobQuote')({ bookingId });
        _closeModal();
        window.location.href = 'booking.html';
    } catch (err) {
        _showInlineError(err.message || 'Payment failed. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = `Approve & Pay GHS ${Number(total).toFixed(2)}`; }
    }
}

// ── Reject ────────────────────────────────────────────────────────────────────
function _openReject() {
    const ta = document.getElementById('hh-qm-rj-reason');
    if (ta) ta.value = '';
    const rj = document.getElementById('hh-qm-rj-overlay');
    if (rj) { rj.setAttribute('aria-hidden', 'false'); rj.classList.add('open'); }
    const btn = document.getElementById('hh-qm-rj-confirm');
    if (btn) { btn.disabled = false; btn.textContent = 'Reject Quote'; }
}

function _closeReject() {
    const rj = document.getElementById('hh-qm-rj-overlay');
    if (rj) { rj.classList.remove('open'); rj.setAttribute('aria-hidden', 'true'); }
}

async function _confirmReject() {
    const bookingId = _activeId;
    if (!bookingId) return;

    const reason = (document.getElementById('hh-qm-rj-reason')?.value || '').trim();
    const btn    = document.getElementById('hh-qm-rj-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Rejecting…'; }

    try {
        await httpsCallable(_fn(), 'rejectJobQuote')({ bookingId, reason });
        _closeReject();
        _closeModal();
        window.location.href = 'booking.html';
    } catch (err) {
        _showInlineError(err.message || 'Could not reject. Try again.');
        _closeReject();
        if (btn) { btn.disabled = false; btn.textContent = 'Reject Quote'; }
    }
}

function _showInlineError(msg) {
    const body = document.getElementById('hh-qm-body');
    if (!body) return;
    const existing = body.querySelector('.hh-qm-inline-err');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'hh-qm-inline-err';
    el.textContent = msg;
    const approveBtn = body.querySelector('.hh-qm-approve');
    if (approveBtn) body.insertBefore(el, approveBtn);
    else body.appendChild(el);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the quote modal for a signed-in customer.
 * Safe to call multiple times (idempotent per uid).
 */
export function initQuoteModal(uid) {
    if (_uid === uid && _unsub) return;
    if (_unsub) { _unsub(); _unsub = null; }
    _uid = uid;

    _ensureDOM();

    // Handle ?openQuote=BOOKING_ID deep-link from push notification
    const params     = new URLSearchParams(window.location.search);
    const openQuoteId = params.get('openQuote');
    if (openQuoteId && !_dismissed.has(openQuoteId)) {
        // Strip the param from the URL (no page reload, no history entry)
        params.delete('openQuote');
        const cleanUrl = params.toString()
            ? `${window.location.pathname}?${params}`
            : window.location.pathname;
        history.replaceState(null, '', cleanUrl);
        setTimeout(() => _openModal(openQuoteId), 200);
    }

    // Real-time Firestore listener — fires instantly when artisan submits a quote
    const q = query(
        collection(firebaseDb, 'bookings'),
        where('customerId', '==', uid),
        where('status',     '==', 'quoted')
    );

    _unsub = onSnapshot(q, snapshot => {
        const pending = snapshot.docs.find(d => !_dismissed.has(d.id));

        if (!pending) {
            // Booking resolved elsewhere (approved/rejected by another device) — close if open
            if (_isOpen && !snapshot.docs.some(d => d.id === _activeId)) _closeModal();
            return;
        }

        if (_isOpen && _activeId === pending.id) return; // already showing
        _openModal(pending.id);
    }, err => {
        console.warn('[quoteModal] Subscription error:', err);
    });
}

/**
 * Clean up listener and close modal. Called on pagehide.
 */
export function destroyQuoteModal() {
    if (_unsub) { _unsub(); _unsub = null; }
    _closeModal();
    _uid = null;
}
