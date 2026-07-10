// bookRequestPage.js — inspection-first booking flow (single-shell state machine)
//
// Views: request → fee (server-priced receipt) → track (live booking console).
// The server owns every price: this page only displays what getPricingQuote /
// the booking document say. Resume a request with book-request.html?resume=ID.

import '../../../shared/js/utils/global-app.js';
import { getAppContainer } from '../../../shared/js/app/container.js';
import { showToast } from '../../../shared/js/components/toast.js';
import { requireAuth } from '../../../shared/js/utils/authGuard.js';
import { SERVICE_CATEGORIES } from '../../../shared/js/data/serviceCatalog.js';
import { pricingService } from '../../../shared/js/services/pricingService.js';
import { uploadImage, UPLOAD_PRESETS, cdnUrl } from '../../../shared/js/services/cloudinaryService.js';
import { mapError } from '../../../shared/js/utils/errorCopy.js';

const MAX_PHOTOS   = 4;
const LOC_CACHE_KEY = 'hh_detected_location';
const LOC_TTL_MS    = 10 * 60_000;
const ACCRA         = { lat: 5.6037, lng: -0.1870, label: 'Accra (approximate)' };

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const ghs = (n) => `GHS ${Number(n || 0).toFixed(2)}`;

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
    uid: null,
    db: null,
    view: 'request',
    catId: null,
    photos: [],          // { publicId, version, url, uploading, el }
    lat: null, lng: null, locLabel: null,
    quote: null,         // server pricing quote
    feeTimer: null,
    bookingId: null,
    unsub: null,
    ctaAction: null,
    walletBalance: null,
};

const $ = (id) => document.getElementById(id);

// ── View switching ────────────────────────────────────────────────────────────
const VIEW_META = {
    request: { kicker: 'New request',   title: 'Book a visit',      progress: 33 },
    fee:     { kicker: 'Step 2 of 2',   title: 'Your visit fee',    progress: 66 },
    track:   { kicker: 'Live status',   title: 'Your request',      progress: 100 },
};

function switchView(name) {
    S.view = name;
    ['request', 'fee', 'track'].forEach(v => {
        const el = $(`view-${v}`);
        el.hidden = v !== name;
        el.classList.remove('enter');
    });
    const el = $(`view-${name}`);
    void el.offsetWidth;                       // restart stagger animation
    el.classList.add('enter');

    const meta = VIEW_META[name];
    $('br-kicker').textContent = meta.kicker;
    $('br-title').textContent  = meta.title;
    $('br-progress').style.width = `${meta.progress}%`;
    $('br-progressbar').setAttribute('aria-valuenow', String(meta.progress));
    $('br-scroll').scrollTo({ top: 0 });
}

function setCta(label, action, { ghost = false, disabled = false, meta = '' } = {}) {
    const btn = $('br-cta');
    btn.textContent = label;
    btn.disabled = disabled;
    btn.classList.toggle('ghost', ghost);
    S.ctaAction = action;
    $('br-footer-meta').textContent = meta;
}

async function runCta() {
    if (typeof S.ctaAction !== 'function') return;
    const btn = $('br-cta');
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'One moment…';
    try {
        await S.ctaAction();
    } catch (err) {
        console.error('[book-request]', err);
        // Never surface a raw Firebase code (e.g. "internal") at a payment moment.
        showToast(mapError(err, 'Something went wrong. Please try again.'));
    } finally {
        // Views that moved on set their own CTA; only restore if unchanged
        if (btn.textContent === 'One moment…') { btn.textContent = prev; btn.disabled = false; }
    }
}

// ── VIEW 1 — request form ─────────────────────────────────────────────────────
function renderCategories() {
    const grid = $('br-cat-grid');
    grid.innerHTML = SERVICE_CATEGORIES.map(c => `
        <button type="button" class="br-cat-tile" role="radio" aria-checked="false" data-cat="${esc(c.id)}">
            <span class="br-cat-ico">${c.icon}</span>
            <span class="br-cat-lbl">${esc(c.categoryLabel)}</span>
        </button>`).join('');
    grid.addEventListener('click', (e) => {
        const tile = e.target.closest('.br-cat-tile');
        if (tile) selectCategory(tile.dataset.cat);
    });
}

function selectCategory(id) {
    S.catId = id;
    document.querySelectorAll('.br-cat-tile').forEach(t =>
        t.setAttribute('aria-checked', t.dataset.cat === id ? 'true' : 'false'));
}

function activeCategory() {
    return SERVICE_CATEGORIES.find(c => c.id === S.catId) || null;
}

// Location: cached → GPS → Accra fallback. Address stays user-editable.
async function detectLocation(force = false) {
    const line = $('br-loc-line');
    if (!force) {
        try {
            const c = JSON.parse(localStorage.getItem(LOC_CACHE_KEY) || 'null');
            if (c && c.lat && (Date.now() - (c.ts || 0)) < LOC_TTL_MS) {
                S.lat = c.lat; S.lng = c.lon ?? c.lng; S.locLabel = c.loc || 'Detected location';
                line.textContent = S.locLabel;
                return;
            }
        } catch { /* fall through to GPS */ }
    }
    line.textContent = 'Detecting your location…';
    const pos = await new Promise(res => {
        if (!navigator.geolocation) return res(null);
        navigator.geolocation.getCurrentPosition(
            p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => res(null),
            { timeout: 8000, maximumAge: 60_000 },
        );
    });
    if (!pos) {
        S.lat = ACCRA.lat; S.lng = ACCRA.lng; S.locLabel = ACCRA.label;
        line.textContent = `${ACCRA.label} — type your address below`;
        return;
    }
    S.lat = pos.lat; S.lng = pos.lng; S.locLabel = 'Detected location';
    try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.lat}&lon=${pos.lng}&format=json`);
        const j = await r.json();
        if (j?.display_name) S.locLabel = j.display_name.split(',').slice(0, 3).join(',');
    } catch { /* keep generic label */ }
    line.textContent = S.locLabel;
    try {
        localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ lat: S.lat, lon: S.lng, loc: S.locLabel, ts: Date.now() }));
    } catch { /* storage full/blocked — non-fatal */ }
}

// Photos — upload immediately, keep publicId + full CDN URL (no transform:
// derived transforms 404 on the current Cloudinary plan).
function wirePhotos() {
    $('br-photo-add').addEventListener('click', () => $('br-photo-input').click());
    $('br-photo-input').addEventListener('change', async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        for (const file of files) {
            if (S.photos.length >= MAX_PHOTOS) { showToast(`Up to ${MAX_PHOTOS} photos.`); break; }
            addPhoto(file);
        }
    });
}

async function addPhoto(file) {
    const thumb = document.createElement('div');
    thumb.className = 'br-photo-thumb uploading';
    thumb.innerHTML = `<img alt="Problem photo" src="${URL.createObjectURL(file)}"/>`;
    $('br-photo-row').insertBefore(thumb, $('br-photo-add'));

    const entry = { publicId: null, version: null, url: null, uploading: true, el: thumb };
    S.photos.push(entry);
    try {
        const { publicId, version } = await uploadImage(file, UPLOAD_PRESETS.job);
        entry.publicId = publicId; entry.version = version;
        entry.url = cdnUrl(publicId, '', version);
        entry.uploading = false;
        thumb.classList.remove('uploading');
        const x = document.createElement('button');
        x.className = 'br-photo-x'; x.type = 'button'; x.textContent = '×';
        x.setAttribute('aria-label', 'Remove photo');
        x.addEventListener('click', () => {
            S.photos = S.photos.filter(p => p !== entry);
            thumb.remove();
        });
        thumb.appendChild(x);
    } catch (err) {
        S.photos = S.photos.filter(p => p !== entry);
        thumb.remove();
        showToast(mapError(err, 'Photo upload failed.'));
    }
}

function validateRequest() {
    if (!S.catId) { showToast('Choose a service category.'); return false; }
    const desc = $('br-desc').value.trim();
    if (desc.length < 10) { showToast('Describe the problem in a little more detail.'); return false; }
    if (!$('br-address').value.trim()) { showToast('Add your address so the professional can find you.'); return false; }
    if (S.lat == null || S.lng == null) { showToast('Still detecting your location — one second.'); return false; }
    if (S.photos.some(p => p.uploading)) { showToast('Photos are still uploading…'); return false; }
    return true;
}

// ── VIEW 2 — fee receipt ──────────────────────────────────────────────────────
async function goToFee() {
    if (!validateRequest()) return;
    const cat = activeCategory();
    S.quote = await pricingService.getPricingQuote({ category: cat.id, lat: S.lat, lng: S.lng });
    renderReceipt();
    switchView('fee');
    setCta('Confirm & find my professional', confirmRequest);
    startFeeLockTicker();
}

function renderReceipt() {
    const q = S.quote, cat = activeCategory();
    $('br-choice-line').innerHTML = `
        <span class="br-cat-ico">${cat.icon}</span>
        <span><strong>${esc(cat.categoryLabel)}</strong> visit &middot; ${esc($('br-desc').value.trim().slice(0, 60))}…</span>`;
    $('br-receipt-rows').innerHTML = `
        <div class="br-receipt-row">
            <span class="lbl">Inspection &amp; diagnosis<small>${esc(cat.categoryLabel)} professional, on site</small></span>
            <span class="amt">${ghs(q.inspectionFee)}</span>
        </div>
        <div class="br-receipt-row">
            <span class="lbl">Travel${q.travelEstimated ? '<small>estimated — exact pro not matched yet</small>' : `<small>${q.distanceKm} km</small>`}</span>
            <span class="amt">${ghs(q.travelFee)}</span>
        </div>`;
    $('br-receipt-total').textContent = ghs(q.calloutFee);
}

function startFeeLockTicker() {
    clearInterval(S.feeTimer);
    const tick = async () => {
        const left = Date.parse(S.quote.expiresAt) - Date.now();
        if (left <= 0) {
            clearInterval(S.feeTimer);
            try {
                S.quote = await pricingService.getPricingQuote({ category: S.catId, lat: S.lat, lng: S.lng });
                renderReceipt(); startFeeLockTicker();
                showToast('Fee refreshed.');
            } catch { $('br-fee-lock').textContent = 'Fee expired — go back and retry.'; }
            return;
        }
        const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
        $('br-fee-lock').textContent = `Fee locked for ${m}:${String(s).padStart(2, '0')}`;
    };
    tick();
    S.feeTimer = setInterval(tick, 1000);
}

async function confirmRequest() {
    const cat = activeCategory();
    try {
        const { bookingId } = await pricingService.createInspectionBooking({
            quoteToken:   S.quote.quoteToken,
            address:      $('br-address').value.trim(),
            description:  $('br-desc').value.trim(),
            photos:       S.photos.map(p => p.url).filter(Boolean),
            serviceLabel: cat.categoryLabel,
        });
        clearInterval(S.feeTimer);
        sessionStorage.setItem('hh_active_request', bookingId);
        enterTrack(bookingId);
    } catch (err) {
        if (/expired|not found/i.test(err?.message || '')) {
            S.quote = await pricingService.getPricingQuote({ category: cat.id, lat: S.lat, lng: S.lng });
            renderReceipt(); startFeeLockTicker();
            showToast('The fee was refreshed — please confirm again.');
            return;
        }
        throw err;
    }
}

// ── VIEW 3 — live tracking ────────────────────────────────────────────────────
function enterTrack(bookingId) {
    S.bookingId = bookingId;
    switchView('track');
    setCta('Loading…', null, { disabled: true });
    let firstSnap = true;
    if (S.unsub) S.unsub();
    S.unsub = S.db.subscribeToDocument('bookings', bookingId,
        (snap) => {
            if (!snap?.exists) {
                // Stale ?resume= (deleted/expired booking, or one belonging to
                // another account that rules hide). Don't hang on "Loading…" —
                // show an honest recoverable dead-end.
                if (firstSnap) renderTrackNotFound();
                return;
            }
            firstSnap = false;
            renderTrack(snap.data || {});
        },
        () => showToast('Connection lost — retrying…'));
}

function renderTrackNotFound() {
    $('br-track-body').innerHTML = `
        <div class="br-search-hero br-stagger" style="padding-top:24px">
            <div class="br-state-ico warn"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            <p class="br-search-title">Request unavailable</p>
            <p class="br-search-sub">We couldn't find this request. It may have been closed or removed.</p>
        </div>`;
    setCta('Start a new request', () => {
        sessionStorage.removeItem('hh_active_request');
        location.href = 'book-request.html';
    });
}

function timeline(stages, doneIdx, liveIdx) {
    return `<div class="br-timeline">` + stages.map((st, i) => {
        const cls = i < doneIdx ? 'done' : i === liveIdx ? 'live' : i < liveIdx ? 'done' : 'todo';
        const dot = i < Math.max(doneIdx, liveIdx)
            ? `<svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`
            : String(i + 1);
        return `
        <div class="br-tl-node ${cls}">
            <span class="br-tl-dot">${dot}</span>
            <p class="br-tl-title">${esc(st.t)}</p>
            <p class="br-tl-sub">${st.s}</p>
        </div>`;
    }).join('') + `</div>`;
}

function proCard(b) {
    const name   = b.artisanName || b.currentArtisanName || 'Your professional';
    const photo  = b.currentArtisanPhoto || null;
    const rating = b.currentArtisanRating || null;
    const initials = name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    return `
    <div class="br-pro-card">
        <div class="br-pro-av">${photo ? `<img src="${esc(photo)}" alt=""/>` : esc(initials)}</div>
        <div class="br-pro-body">
            <p class="br-pro-name">${esc(name)}</p>
            <p class="br-pro-meta">${rating ? `<span class="star">★ ${esc(String(rating))}</span>` : ''}<span>${esc(b.serviceType || '')}</span></p>
        </div>
    </div>`;
}

const STAGES = [
    { t: 'Request sent',        s: 'Your problem, photos and location are in.' },
    { t: 'Professional matched', s: 'A verified pro accepts your inspection visit.' },
    { t: 'Callout fee secured',  s: 'Held in escrow — credited toward your final job price.' },
    { t: 'Inspection',           s: 'They assess the problem, then send you a fixed quote.' },
];

async function renderTrack(b) {
    const body = $('br-track-body');
    const st = (b.status || '').toLowerCase();

    if (['pending', 'dispatching', 'searching', 'dispatched', 'assigned'].includes(st)) {
        body.innerHTML = `
            <div class="br-search-hero br-stagger">
                <div class="br-search-rings">
                    <span class="ring"></span><span class="ring"></span><span class="ring"></span>
                    <span class="core"><svg viewBox="0 0 24 24" fill="none" width="18" height="18"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
                </div>
                <p class="br-search-title">Finding your professional…</p>
                <p class="br-search-sub">We're checking verified ${esc(b.serviceType || '')} pros near ${esc((b.address || '').split(',')[0])}. This usually takes a few minutes.</p>
            </div>
            ${timeline(STAGES, 1, 1)}`;
        setCta('Cancel request', cancelRequest, { ghost: true });

    } else if (st === 'accepted' && !b.calloutPaid) {
        await loadWallet();
        const fee   = Number(b.calloutFee || 0);
        const short = S.walletBalance != null && S.walletBalance < fee;
        body.innerHTML = `
            <div class="br-stagger">${proCard(b)}</div>
            ${timeline(STAGES, 2, 2)}
            <div class="br-wallet-strip ${short ? 'short' : ''} br-stagger">
                <span>Wallet balance</span>
                <strong>${S.walletBalance == null ? '—' : ghs(S.walletBalance)}</strong>
            </div>`;
        if (short) {
            setCta('Top up wallet to continue', () => { location.href = 'topup.html'; },
                { meta: `You need ${ghs(fee)} for the callout fee.` });
        } else {
            setCta(`Pay callout fee · ${ghs(fee)}`, payCallout,
                { meta: 'Held in escrow. Credited toward your job. Refunded if no quote follows.' });
        }

    } else if (['inspection_scheduled', 'en_route', 'in_progress'].includes(st) && !b.quoteApproved) {
        const live = st === 'inspection_scheduled' ? 3 : 3;
        const sub  = st === 'inspection_scheduled'
            ? 'Your callout fee is secured. The professional will head over to assess the problem.'
            : st === 'en_route' ? 'Your professional is on the way.' : 'Inspection happening now.';
        body.innerHTML = `
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico ok"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div>
                <p class="br-search-title">Inspection booked</p>
                <p class="br-search-sub">${sub}</p>
            </div>
            <div class="br-stagger">${proCard(b)}</div>
            ${timeline(STAGES, 3, live)}`;
        setCta('View my bookings', () => { location.href = 'booking.html'; });

    } else if (st === 'inspection_done') {
        body.innerHTML = `
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico ok"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg></div>
                <p class="br-search-title">Inspection complete</p>
                <p class="br-search-sub">${esc(b.artisanName || 'Your professional')} has assessed the problem. Your fixed quote is on its way — we'll notify you.</p>
            </div>
            ${timeline(STAGES, 4, 4)}`;
        setCta('View my bookings', () => { location.href = 'booking.html'; });

    } else if (st === 'quoted') {
        body.innerHTML = `
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico ok"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M12 2v20M17 7H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>
                <p class="br-search-title">Your quote is ready</p>
                <p class="br-search-sub">Review it, approve it, or request one revision. Your ${ghs(b.calloutFee)} callout fee is subtracted from the total.</p>
            </div>`;
        setCta('Review quote', () => { location.href = `quote-approval.html?bookingId=${encodeURIComponent(S.bookingId)}`; });

    } else if (st === 'cancelled') {
        body.innerHTML = `
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico bad"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></div>
                <p class="br-search-title">Request closed</p>
                <p class="br-search-sub">${esc(b.cancellationReason || 'This request was cancelled.')}${b.calloutSettled === 'refunded' ? ' Your callout fee was refunded to your wallet.' : ''}</p>
            </div>`;
        setCta('Start a new request', () => { sessionStorage.removeItem('hh_active_request'); location.href = 'book-request.html'; });

    } else if (st === 'unfulfilled') {
        body.innerHTML = `
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico warn"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M12 9v4m0 4h.01M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
                <p class="br-search-title">No professional available</p>
                <p class="br-search-sub">Everyone nearby is busy right now. Nothing was charged — try again shortly.</p>
            </div>`;
        setCta('Try again', () => { sessionStorage.removeItem('hh_active_request'); location.href = 'book-request.html'; });

    } else {
        // quote approved / job executing — hand over to the bookings screen
        body.innerHTML = `
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico ok"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div>
                <p class="br-search-title">Job confirmed</p>
                <p class="br-search-sub">Payment is secured in escrow. Track progress from your bookings.</p>
            </div>`;
        setCta('View my bookings', () => { location.href = 'booking.html'; });
    }
}

async function loadWallet() {
    try {
        const snap = await S.db.getDocument('customers', S.uid);
        S.walletBalance = Number(snap?.data?.walletBalance ?? 0);
    } catch { S.walletBalance = null; }
}

async function payCallout() {
    try {
        await pricingService.payCalloutFee(S.bookingId);
        showToast('Callout fee secured — inspection booked!');
        // subscription re-renders on the status change
    } catch (err) {
        if (/insufficient/i.test(err?.message || '')) {
            await loadWallet();
            showToast(mapError(err, 'Your wallet balance is too low for the callout fee.'));
            const b = { status: 'accepted', calloutPaid: false, calloutFee: S.quote?.calloutFee };
            // Re-render via fresh fetch so the fee comes from the booking doc
            const snap = await S.db.getDocument('bookings', S.bookingId);
            if (snap?.exists) renderTrack(snap.data || b);
            return;
        }
        throw err;
    }
}

async function cancelRequest() {
    if (!window.confirm('Cancel this request?')) return;
    await pricingService.cancelInspectionBooking(S.bookingId, 'Cancelled by customer');
    sessionStorage.removeItem('hh_active_request');
    showToast('Request cancelled.');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
    const user = await requireAuth();
    if (!user) return;
    S.uid = user.uid;
    S.db  = getAppContainer().services.databaseService;

    renderCategories();
    wirePhotos();

    $('br-desc').addEventListener('input', (e) => {
        $('br-count').textContent = `${e.target.value.length}/2000`;
    });
    $('br-loc-refresh').addEventListener('click', () => detectLocation(true));
    $('br-cta').addEventListener('click', runCta);
    $('br-back').addEventListener('click', () => {
        if (S.view === 'fee') {
            clearInterval(S.feeTimer);
            switchView('request');
            setCta('See the visit fee', goToFee);
        } else if (S.view === 'track') {
            location.href = 'booking.html';
        } else if (history.length > 1) {
            history.back();
        } else {
            location.href = 'dashboard.html';
        }
    });

    // Deep links: ?resume=BOOKING_ID re-opens the live console;
    // ?cat= / sessionStorage preselect a category.
    const params = new URLSearchParams(location.search);
    const resume = params.get('resume');
    if (resume) {
        enterTrack(resume);
    } else {
        const pre = params.get('cat') || sessionStorage.getItem('hh_service_preselect');
        if (pre && SERVICE_CATEGORIES.some(c => c.id === pre)) selectCategory(pre);
        sessionStorage.removeItem('hh_service_preselect');
        switchView('request');
        setCta('See the visit fee', goToFee);
        detectLocation();
    }
}

window.addEventListener('pagehide', () => {
    if (S.unsub) S.unsub();
    clearInterval(S.feeTimer);
});

init();
