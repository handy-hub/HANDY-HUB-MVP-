// bookRequestPage.js — inspection-first booking flow (single-shell state machine)
//
// Views: request → fee (server-priced receipt) → track (live booking console).
// The server owns every price: this page only displays what getPricingQuote /
// the booking document say. Resume a request with book-request.html?resume=ID.

import '../../../shared/js/utils/global-app.js';
import { getAppContainer } from '../../../shared/js/app/container.js';
import { showToast } from '../../../shared/js/components/toast.js';
import { requireAuth } from '../../../shared/js/utils/authGuard.js';
import { SERVICE_CATEGORIES, resolveCategory } from '../../../shared/js/data/serviceCatalog.js';
import { pricingService } from '../../../shared/js/services/pricingService.js';
import { uploadImage, UPLOAD_PRESETS, cdnUrl } from '../../../shared/js/services/cloudinaryService.js';
import { mapError } from '../../../shared/js/utils/errorCopy.js';
import { resolveArtisan, initialsOf, resolveJourney, journeyStages } from '../../../shared/js/domain/bookingTruth.js';
import {
    TIME_WINDOWS, availableWindowsFor, validateScheduleRequest,
    earliestSelectableDate, latestSelectableDate, resolveSchedule,
} from '../../../shared/js/domain/bookingSchedule.js';

const MAX_PHOTOS   = 4;
const LOC_CACHE_KEY = 'hh_detected_location';

// Address autocomplete. Optional by design: if the key, the network or the API
// is unavailable, attach() reports unavailable and the field stays exactly the
// free-text input it has always been.
import { attachAddressAutocomplete } from '../../../shared/js/services/placesService.js';
const LOC_TTL_MS    = 10 * 60_000;
const ACCRA         = { lat: 5.6037, lng: -0.1870, label: 'Accra (approximate)' };

// A half-written request is the customer's work, and this page used to throw it
// away. Refreshing, backgrounding the tab on a phone, or following any link out
// of the form wiped the category, the description, the address and every photo
// — photos that had already been uploaded to Cloudinary, so the loss cost
// bandwidth as well as typing.
//
// A draft is the one thing localStorage is legitimately for: non-authoritative
// intake state, never a settled financial artefact (CLAUDE.md §2).
const DRAFT_KEY_BASE = 'hh_booking_draft';
const DRAFT_TTL_MS   = 24 * 60 * 60_000;

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
    // TRUE only when lat/lng came from a real GPS fix (or a cached one still
    // inside its TTL). Never set by a display fallback. goToFee() refuses to
    // price or book while this is false.
    locPrecise: false,
    artisanId: null,     // the professional the customer chose, if any
    artisanName: null,
    // ── When ─────────────────────────────────────────────────────────────────
    // 'asap' is the default and reproduces the behaviour every HandyHub booking
    // has ever had: dispatch starts the moment the booking is written. 'scheduled'
    // is the new choice, and only then do date/window carry meaning.
    when: 'asap',        // 'asap' | 'scheduled'
    schedDate: null,     // 'YYYY-MM-DD' wall clock, Africa/Accra
    schedWindow: null,   // a TIME_WINDOWS id
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
    boot:    { kicker: 'Loading',       title: 'One moment…',       progress: 5 },
    request: { kicker: 'New request',   title: 'Book a visit',      progress: 33 },
    // "Step 2 of 2" implied the journey ended here, reinforcing the impression
    // that this screen charges. It does not — finding a professional and paying
    // both come after it.
    fee:     { kicker: 'Before we search', title: 'Your visit fee', progress: 66 },
    // 100% the instant a request was sent — a full bar over a job that has not
    // been accepted, paid for, inspected, quoted or done. renderTrack() now
    // drives this from the real stage; 20 is only what the loading state shows
    // before the first snapshot arrives.
    track:   { kicker: 'Live status',   title: 'Your request',      progress: 20 },
};

function switchView(name) {
    S.view = name;
    // 'boot' is the neutral state the page opens in. Including it here means no
    // other view is ever painted before init() has decided which one is correct.
    ['boot', 'request', 'fee', 'track'].forEach(v => {
        const el = $(`view-${v}`);
        if (!el) return;
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
    scheduleDraftSave();
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
                // A cached fix was a real GPS reading when it was written, so it
                // counts as precise within its TTL.
                S.lat = c.lat; S.lng = c.lon ?? c.lng; S.locPrecise = true;
                S.locLabel = c.loc || 'Detected location';
                line.textContent = S.locLabel;
                line.classList.remove('br-loc-failed');
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
        // DO NOT substitute Accra for the customer's position.
        //
        // This previously set S.lat/S.lng to the city centre on any GPS failure.
        // Those coordinates pass the server's Ghana-bounds check (Accra is in
        // Ghana), so a booking was created with a position that was not the
        // customer's — dispatch then matched and ranked artisans around the city
        // centre while the customer had typed their real address. A missing
        // location must never be disguised as a valid one.
        S.lat = null; S.lng = null; S.locPrecise = false;
        S.locLabel = ACCRA.label;
        line.textContent = 'We could not get your location — tap to try again';
        line.classList.add('br-loc-failed');
        return;
    }
    S.lat = pos.lat; S.lng = pos.lng; S.locPrecise = true;
    S.locLabel = 'Detected location';
    line.classList.remove('br-loc-failed');
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
        attachPhotoRemove(entry, thumb);
        scheduleDraftSave();
    } catch (err) {
        S.photos = S.photos.filter(p => p !== entry);
        thumb.remove();
        showToast(mapError(err, 'Photo upload failed.'));
    }
}

function attachPhotoRemove(entry, thumb) {
    const x = document.createElement('button');
    x.className = 'br-photo-x'; x.type = 'button'; x.textContent = '×';
    x.setAttribute('aria-label', 'Remove photo');
    x.addEventListener('click', () => {
        S.photos = S.photos.filter(p => p !== entry);
        thumb.remove();
        scheduleDraftSave();
    });
    thumb.appendChild(x);
}

// ── Draft persistence ────────────────────────────────────────────────────────
//
// Read and written through ONE key builder, and never called before
// requireAuth() has resolved — so the uid is known at both ends and the two
// keys cannot diverge the way the notification cache's did (CLAUDE.md §1).
// This is not a first-paint cache of remote data, so mountInstantView does not
// apply: there is no subscription behind it, only the customer's own unsent
// typing.
const draftKey = () => `${DRAFT_KEY_BASE}:${S.uid}`;
let draftTimer = null;

function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
    draftTimer = null;
    if (!S.uid || S.view !== 'request') return;
    const draft = {
        v: 1,
        ts: Date.now(),
        catId:   S.catId,
        desc:    $('br-desc')?.value    || '',
        address: $('br-address')?.value || '',
        // Committed uploads only — an in-flight photo has no URL to come back to.
        photos: S.photos.filter(p => p.url && !p.uploading)
                        .map(p => ({ publicId: p.publicId, version: p.version, url: p.url })),
        artisanId:   S.artisanId,
        artisanName: S.artisanName,
        // A chosen appointment is the customer's work too. Losing it on a
        // refresh means re-deciding when to be home, which is the most
        // effortful choice on this form.
        when:        S.when,
        schedDate:   S.schedDate,
        schedWindow: S.schedWindow,
    };
    // Nothing worth keeping — don't leave a husk that "restores" an empty form.
    if (!draft.catId && !draft.desc.trim() && !draft.address.trim() &&
        !draft.photos.length && draft.when === 'asap') {
        clearDraft(); return;
    }
    try { localStorage.setItem(draftKey(), JSON.stringify(draft)); }
    catch { /* storage full or blocked — non-fatal, the form still works */ }
}

function clearDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    try { localStorage.removeItem(draftKey()); } catch { /* non-fatal */ }
}

/**
 * Paint the customer's own words back before anything is fetched.
 *
 * Coordinates are deliberately NOT restored. lat/lng carry a precision claim
 * (S.locPrecise) that dispatch matches and charges travel on; a fix from
 * yesterday is not where the customer is standing today, and reviving one would
 * be the old Accra fallback wearing a different hat. detectLocation()
 * re-establishes position, and until it does validateRequest() refuses to
 * price. The address TEXT is the customer's own and comes back.
 */
function restoreDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(draftKey()) || 'null'); }
    catch { /* corrupt — treat as absent */ }
    if (!d || d.v !== 1) return false;
    if ((Date.now() - (d.ts || 0)) > DRAFT_TTL_MS) { clearDraft(); return false; }

    if (d.catId && resolveCategory(d.catId)) selectCategory(d.catId);
    if (d.desc) {
        $('br-desc').value = d.desc;
        $('br-count').textContent = `${d.desc.length}/2000`;
    }
    if (d.address) $('br-address').value = d.address;
    if (d.artisanId) { S.artisanId = String(d.artisanId); S.artisanName = d.artisanName || null; }

    // A saved slot is re-validated, never trusted: a draft written yesterday may
    // name a window that has since passed. renderSchedule() disables anything
    // unbookable, so restoring an expired choice would silently clear it —
    // setWhen() runs the same validation the picker does.
    if (d.when === 'scheduled') {
        S.schedDate   = d.schedDate   || null;
        S.schedWindow = d.schedWindow || null;
        setWhen('scheduled', { silent: true });
    }

    for (const p of (d.photos || [])) {
        if (!p.url || S.photos.length >= MAX_PHOTOS) continue;
        const thumb = document.createElement('div');
        thumb.className = 'br-photo-thumb';
        thumb.innerHTML = `<img alt="Problem photo" src="${esc(p.url)}"/>`;
        $('br-photo-row').insertBefore(thumb, $('br-photo-add'));
        const entry = { publicId: p.publicId || null, version: p.version || null, url: p.url, uploading: false, el: thumb };
        S.photos.push(entry);
        attachPhotoRemove(entry, thumb);
    }

    return !!(String(d.desc || '').trim() || String(d.address || '').trim() || (d.photos || []).length);
}

// ── Inline validation ────────────────────────────────────────────────────────
// A toast was the only signal that a tap had been rejected: it named no field,
// moved no focus, and vanished. On a scrolled form the customer could tap and
// see nothing happen at all. Errors now attach to the field, persist until
// fixed, and pull the field into view — the input is never touched.
function clearFieldError(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('br-invalid');
    el.removeAttribute('aria-invalid');
    const msg = document.getElementById(`${id}-err`);
    if (msg) msg.remove();
}

function setFieldError(id, message) {
    const el = $(id);
    if (!el) { showToast(message); return; }
    clearFieldError(id);
    el.classList.add('br-invalid');
    el.setAttribute('aria-invalid', 'true');
    const msg = document.createElement('p');
    msg.className = 'br-err';
    msg.id = `${id}-err`;
    msg.setAttribute('role', 'alert');
    msg.textContent = message;
    // Insert AFTER the field wrapper, never inside it. Appending into
    // .br-loc-card — which is display:flex — made the message a flex-row sibling
    // of the beacon and the input, which collapsed the input's hit area so the
    // customer could not tap the very field they had just been told to fix.
    const wrapper = el.closest('.br-field, .br-loc-card') || el;
    wrapper.insertAdjacentElement('afterend', msg);

    // Focus scrolls the field into view natively and raises the keyboard on it.
    // A separate smooth scrollIntoView was animating the input for ~300 ms, during
    // which it could not be typed into — the customer taps the field the app just
    // told them to fix and the first keystrokes go nowhere. Focus alone is instant.
    try { el.focus(); }
    catch { el.scrollIntoView({ block: 'center' }); }
}

// ── WHEN — as soon as possible, or a booked slot ─────────────────────────────
//
// The booking engine could previously express exactly one moment: now. Every
// booking was written with status 'pending' and no time, onBookingCreated
// dispatched it immediately, and the artisan was given three minutes to answer.
// That is the right behaviour for a burst pipe and the wrong behaviour for a
// repaint next Tuesday, and nothing in the system could tell the two apart.
//
// ASAP remains the default, so a customer who does not engage with this section
// gets precisely the behaviour they got before. Choosing a slot is an opt-in
// into a different promise: the professional commits to a window, and
// firestore.rules will not let them mark themselves en route before it opens.
//
// The rules live in shared/js/domain/bookingSchedule.js and are the SAME rules
// createInspectionBooking applies. This picker cannot offer a slot the server
// would refuse, because it asks the server's own validator which slots exist.

function setWhen(mode, { silent = false } = {}) {
    S.when = mode === 'scheduled' ? 'scheduled' : 'asap';

    document.querySelectorAll('#br-when .br-when-opt').forEach((btn) => {
        btn.setAttribute('aria-checked', String(btn.dataset.when === S.when));
    });
    $('br-sched').hidden = S.when !== 'scheduled';

    if (S.when === 'asap') {
        // Clear rather than remember. A stale slot silently re-applying on a
        // later visit is how a customer ends up booked for a day they did not
        // choose — and "as soon as possible" has to mean it.
        S.schedDate = null;
        S.schedWindow = null;
    } else {
        const dateEl = $('br-date');
        dateEl.min = earliestSelectableDate();
        dateEl.max = latestSelectableDate();
        if (!S.schedDate || S.schedDate < dateEl.min || S.schedDate > dateEl.max) {
            S.schedDate = dateEl.min;
        }
        dateEl.value = S.schedDate;
        renderSlots();
    }
    if (!silent) scheduleDraftSave();
}

function renderSlots() {
    const grid = $('br-slot-grid');
    const windows = availableWindowsFor(S.schedDate);

    // A slot the customer had chosen that is no longer bookable (they left the
    // tab open past midday) is dropped here rather than carried into a request
    // the server will reject.
    if (S.schedWindow && !windows.find(w => w.id === S.schedWindow && w.available)) {
        S.schedWindow = null;
    }

    grid.innerHTML = '';
    for (const w of windows) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'br-slot';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(S.schedWindow === w.id));
        btn.dataset.slot = w.id;
        if (!w.available) {
            btn.disabled = true;
            // The reason travels with the control. "Unavailable" alone makes the
            // customer guess whether the problem is the day, the hour or the app.
            btn.title = w.reason || 'Not available';
        }
        btn.innerHTML =
            `<span class="br-slot-name">${esc(w.label)}</span>` +
            `<span class="br-slot-time">${esc(w.clock)}</span>`;
        grid.appendChild(btn);
    }

    const note = $('br-sched-note');
    note.classList.remove('is-error');
    if (S.schedWindow) {
        const v = validateScheduleRequest({ dateStr: S.schedDate, windowId: S.schedWindow });
        note.textContent = v.ok
            ? `Your professional will arrive ${v.label}.`
            : v.reason;
        note.classList.toggle('is-error', !v.ok);
    } else if (!windows.some(w => w.available)) {
        note.textContent = 'No windows left on this day — pick a later date.';
    } else {
        note.textContent = 'Pick the window that suits you.';
    }
}

function initWhen() {
    $('br-when')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.br-when-opt');
        if (btn) setWhen(btn.dataset.when);
    });
    $('br-date')?.addEventListener('change', (e) => {
        S.schedDate = e.target.value || earliestSelectableDate();
        renderSlots();
        scheduleDraftSave();
    });
    $('br-slot-grid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.br-slot');
        if (!btn || btn.disabled) return;
        S.schedWindow = btn.dataset.slot;
        renderSlots();
        scheduleDraftSave();
    });
}

/**
 * The appointment as the server wants it, or null for the immediate flow.
 * Returns the wall clock the customer picked — never an instant — so the server
 * decides what "Saturday 2pm" means rather than inheriting this device's
 * timezone. See ACCRA_UTC_OFFSET_MINUTES in bookingSchedule.js.
 */
function schedulePayload() {
    if (S.when !== 'scheduled' || !S.schedDate || !S.schedWindow) return null;
    return { dateStr: S.schedDate, windowId: S.schedWindow };
}

function validateRequest() {
    ['br-desc', 'br-address'].forEach(clearFieldError);

    if (!S.catId) {
        showToast('Choose what needs fixing.');
        $('br-cat-grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return false;
    }
    const desc = $('br-desc').value.trim();
    if (desc.length < 10) {
        setFieldError('br-desc', desc.length
            ? 'A little more detail helps your professional arrive prepared.'
            : 'Tell us what is wrong so the right professional comes.');
        return false;
    }
    if (!$('br-address').value.trim()) {
        setFieldError('br-address', 'Add your address so the professional can find your door.');
        return false;
    }
    if (S.lat == null || S.lng == null) {
        // Not the customer's mistake — say what the app is doing about it.
        // Picking an address from the suggestions also satisfies this, which is
        // why the copy offers it: a customer indoors with no GPS fix used to be
        // unable to book at all.
        setFieldError('br-address',
            'Pick your address from the suggestions, or tap the target icon to locate you.');
        return false;
    }
    if (S.photos.some(p => p.uploading)) {
        showToast('Your photos are still uploading — one moment.');
        return false;
    }
    // A half-chosen appointment is worse than none: "scheduled" with no window
    // would fall through to the immediate flow and dispatch a professional the
    // customer expected on Saturday. Ask for the missing half instead.
    if (S.when === 'scheduled') {
        const v = validateScheduleRequest({ dateStr: S.schedDate, windowId: S.schedWindow });
        if (!v.ok) {
            const note = $('br-sched-note');
            note.textContent = S.schedWindow ? v.reason : 'Choose an arrival window for your visit.';
            note.classList.add('is-error');
            $('br-sched')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return false;
        }
    }
    return true;
}

// ── VIEW 2 — fee receipt ──────────────────────────────────────────────────────
async function goToFee() {
    if (!validateRequest()) return;

    // Refuse to price or book without a real position. Dispatch matches, ranks
    // and charges travel on these coordinates — proceeding with a placeholder
    // would send an artisan to the wrong part of the city while the customer
    // saw their own address on screen.
    if (!S.locPrecise || !Number.isFinite(S.lat) || !Number.isFinite(S.lng)) {
        showToast('We need your location to find professionals near you.');
        const line = $('br-loc-line');
        line?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await detectLocation(true);          // one explicit retry
        if (!S.locPrecise) return;           // still nothing — do not proceed
    }

    const cat = activeCategory();
    // Passing artisanId prices REAL travel distance to that professional instead
    // of an estimate, and routes the request straight to them.
    S.quote = await pricingService.getPricingQuote({
        category: cat.id, lat: S.lat, lng: S.lng, artisanId: S.artisanId,
    });
    renderReceipt();
    switchView('fee');
    // State plainly that this screen takes no money. It shows an itemised total
    // with a locked-in price, which reads exactly like a checkout — so customers
    // reasonably believe they have been charged before anyone was found. The
    // sequencing is already correct (payCalloutFee refuses to run until a
    // professional has accepted); only the screen was misleading.
    setCta('Confirm & find my professional', confirmRequest,
        { meta: 'No payment yet — you only pay once a professional accepts.' });
    startFeeLockTicker();
}

function renderReceipt() {
    const q = S.quote, cat = activeCategory();
    // The receipt is the last screen before a commitment, so it repeats WHEN as
    // well as what. A customer who picked Saturday and then sees only a fee is
    // being asked to confirm on trust that the app remembered.
    const sched = schedulePayload();
    const when  = sched ? validateScheduleRequest(sched) : null;
    $('br-choice-line').innerHTML = `
        <span class="br-cat-ico">${cat.icon}</span>
        <span><strong>${esc(cat.categoryLabel)}</strong> visit &middot; ${esc($('br-desc').value.trim().slice(0, 60))}…</span>`;
    const whenRow = $('br-when-summary');
    if (whenRow) {
        whenRow.textContent = when && when.ok
            ? `Arriving ${when.label}`
            : 'Arriving as soon as a professional accepts';
    }
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

// The visible countdown is gone.
//
// It ran a ticking mm:ss lock on a screen whose own footer says "No payment
// yet". A ticking clock on a screen that takes no money reads as a financial
// deadline the customer is losing, and there is no action they can take to beat
// it — the fee simply reprices. That is manufactured urgency standing in for
// clarity, and HandyHub should read as reliable, not desperate.
//
// The token still expires server-side; that is a real pricing constraint. It is
// now handled silently: when the quote goes stale we refetch it, and the only
// time the customer hears about it is if the price actually changed, at which
// point they genuinely need to know before confirming.
function startFeeLockTicker() {
    clearTimeout(S.feeTimer);
    const left = Date.parse(S.quote.expiresAt) - Date.now();
    $('br-fee-lock').textContent = '';
    S.feeTimer = setTimeout(async () => {
        const previous = S.quote?.calloutFee;
        try {
            S.quote = await pricingService.getPricingQuote({
                category: S.catId, lat: S.lat, lng: S.lng, artisanId: S.artisanId,
            });
            renderReceipt();
            startFeeLockTicker();
            if (previous != null && Number(previous) !== Number(S.quote.calloutFee)) {
                showToast(`The visit fee is now ${ghs(S.quote.calloutFee)}.`);
            }
        } catch {
            // Refresh failed — say what it means for the customer, not what
            // failed internally. Confirming will re-price server-side anyway.
            $('br-fee-lock').textContent = 'Tap confirm to refresh this price.';
        }
    }, Math.max(left, 1000));
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
            // The wall clock, not an instant — the server canonicalises it in
            // Africa/Accra so a device with the wrong timezone cannot book the
            // customer into a slot they did not choose.
            schedule:     schedulePayload(),
        });
        clearTimeout(S.feeTimer);
        clearDraft();                    // it is a booking now, not a draft
        sessionStorage.setItem('hh_active_request', bookingId);
        enterTrack(bookingId);
    } catch (err) {
        if (/expired|not found/i.test(err?.message || '')) {
            S.quote = await pricingService.getPricingQuote({
                category: cat.id, lat: S.lat, lng: S.lng, artisanId: S.artisanId,
            });
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
    // Paint an honest loading state immediately. Previously the track body was
    // blank until the first snapshot, so a resumed booking showed an empty
    // screen; combined with view-request being the page's default, that read as
    // "your booking is gone".
    $('br-track-body').innerHTML = `
        <div class="br-search-hero br-stagger" style="padding-top:24px">
            <p class="br-search-title">Loading your booking…</p>
            <p class="br-search-sub">Fetching the latest status from your account.</p>
        </div>`;
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

/**
 * The six-stage rail, rendered from the ONE lifecycle projection both apps read
 * (journeyStages → resolveJourney → resolveJobPhase in bookingTruth.js).
 *
 * What stood here was a four-stage list with done/live indices hand-written per
 * branch, and it was wrong in three ways at once. It stopped at the inspection,
 * so from `quoted` onwards — the half of the journey holding the money — the
 * customer saw no rail at all. `inspection_done` passed indices past the end of
 * the array, which painted every stage complete on a job barely half done. And
 * its copy was a second, drifting statement of a lifecycle the shared module
 * already owns.
 */
function journeyRail(stages) {
    const tick = `<svg viewBox="0 0 24 24" fill="none" width="11" height="11" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return `<ol class="br-rail" aria-label="Where this booking is">` + stages.map(st => `
        <li class="br-rail-node ${st.state}"${st.state === 'current' ? ' aria-current="step"' : ''}>
            <span class="br-rail-dot">${st.state === 'done' ? tick : ''}</span>
            <span class="br-rail-lbl">${esc(st.label)}</span>
        </li>`).join('') + `</ol>`;
}

function proCard(b) {
    // One identity resolver across every surface — see bookingTruth.js.
    const a      = resolveArtisan(b);
    const name   = a.name || (a.isAssigned ? 'Your professional' : 'Finding your professional…');
    const photo  = a.photo;
    const rating = a.rating;
    const initials = initialsOf(a.name) || '·';
    // "Who is coming to my home?" — the customer needs more than a name before
    // they pay. Every field here is stamped server-side at acceptance; anything
    // unavailable is simply omitted rather than filled in with a guess.
    const bits = [];
    if (a.verified === true)      bits.push('<span class="br-pro-verified">✓ Verified</span>');
    if (rating !== null)          bits.push(`<span class="star">★ ${esc(rating.toFixed(1))}</span>`);
    if (a.jobsCompleted !== null) bits.push(`<span>${esc(String(a.jobsCompleted))} job${a.jobsCompleted === 1 ? '' : 's'} done</span>`);
    if (a.trade || b.serviceType) bits.push(`<span>${esc(a.trade || b.serviceType)}</span>`);

    return `
    <div class="br-pro-card">
        <div class="br-pro-av">${photo ? `<img src="${esc(photo)}" alt=""/>` : esc(initials)}</div>
        <div class="br-pro-body">
            <p class="br-pro-name">${esc(name)}</p>
            <p class="br-pro-meta">${bits.join('')}</p>
        </div>
    </div>`;
}

async function renderTrack(b) {
    const body = $('br-track-body');
    const st = (b.status || '').toLowerCase();

    // Where am I, in the whole journey — the same question the artisan's screen
    // answers from the same projection, so the two sides never disagree.
    // The lifecycle projection is given the appointment so its copy can say
    // "arriving Saturday" instead of implying someone is already on their way.
    const sched  = resolveSchedule(b);
    const stages = journeyStages(b, 'customer', { schedule: sched });
    const cur    = stages.findIndex(s => s.state === 'current');
    const pct    = cur === -1 ? 100 : Math.round(((cur + 1) / stages.length) * 100);
    $('br-progress').style.width = `${pct}%`;
    $('br-progressbar').setAttribute('aria-valuenow', String(pct));
    const rail = journeyRail(stages);

    if (['pending', 'dispatching', 'searching', 'dispatched', 'assigned'].includes(st)) {
        // Waiting, told truthfully. No countdown and no progress bar: the app
        // genuinely does not know when a professional will accept, and inventing
        // "2 minutes remaining" would be a lie the customer would catch.
        //
        // The old copy promised "a few minutes" while the artisan side is given a
        // 3-hour response window — a mismatch the customer had no way to see.
        const j       = resolveJourney(b, 'customer', { schedule: sched });
        const direct  = !!b.artisanId && (b.currentArtisanName || b.artisanName);
        const waited  = Date.parse(b.createdAt || '') || null;
        const mins    = waited ? Math.floor((Date.now() - waited) / 60000) : null;

        // Escalates in honesty as time passes rather than repeating one promise.
        // The stated response ceiling was "3 hours" long after the dispatch
        // timeout became 3 minutes per round — a number that told a waiting
        // customer to expect an afternoon of silence that was never coming.
        const patience = mins == null || mins < 2
            ? 'Sending your request to professionals nearby.'
            : mins < 15
                ? 'Waiting for a professional to accept.'
                : `Still looking — we've been searching for ${mins} minutes. Each professional gets a few minutes to respond before we move to the next, and we'll notify you the moment one accepts.`;

        body.innerHTML = `
            ${rail}
            <div class="br-search-hero br-stagger">
                <div class="br-search-rings">
                    <span class="ring"></span><span class="ring"></span><span class="ring"></span>
                    <span class="core"><svg viewBox="0 0 24 24" fill="none" width="18" height="18"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
                </div>
                <p class="br-search-title">${direct
                    ? `Waiting for ${esc(b.currentArtisanName || b.artisanName)}`
                    : 'Finding your professional'}</p>
                <p class="br-search-sub">${direct
                    ? `Your request went straight to ${esc(b.currentArtisanName || b.artisanName)}. ${esc(patience)}`
                    : `We're checking verified ${esc(b.serviceType || '')} professionals near ${esc((b.address || '').split(',')[0])}. ${esc(patience)}`}</p>
                <p class="br-search-note">You can close the app — we'll notify you.</p>
            </div>`;
        setCta('Cancel request', cancelRequest, { ghost: true, meta: j.next || '' });

    } else if (st === 'accepted' && !b.calloutPaid) {
        await loadWallet();
        const fee   = Number(b.calloutFee || 0);
        const short = S.walletBalance != null && S.walletBalance < fee;
        // When the visit is booked for a specific window, say so here. This is
        // the screen where the customer parts with money, and "pay to lock in
        // the inspection" is a weaker promise than naming the slot they are
        // locking in.
        const apptAccepted = resolveSchedule(b);
        body.innerHTML = `
            ${rail}
            <div class="br-stagger">${proCard(b)}</div>
            ${apptAccepted.scheduled ? `<p class="br-when-summary br-stagger">Arriving ${esc(apptAccepted.label)}</p>` : ''}
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
        // "The professional will head over" is true of an immediate booking and
        // misleading about an appointment: it invites the customer to expect
        // someone today when the slot they chose is on Saturday.
        const apptBooked = resolveSchedule(b);
        const sub  = st === 'inspection_scheduled'
            ? (apptBooked.scheduled
                ? `Your callout fee is secured and your slot is held for ${apptBooked.label}.`
                : 'Your callout fee is secured. The professional will head over to assess the problem.')
            : st === 'en_route' ? 'Your professional is on the way.' : 'Inspection happening now.';
        body.innerHTML = `
            ${rail}
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico ok"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div>
                <p class="br-search-title">Inspection booked</p>
                <p class="br-search-sub">${sub}</p>
            </div>
            <div class="br-stagger">${proCard(b)}</div>`;
        setCta('View my bookings', () => { location.href = 'booking.html'; });

    } else if (st === 'inspection_done') {
        body.innerHTML = `
            ${rail}
            <div class="br-search-hero br-stagger" style="padding-top:24px">
                <div class="br-state-ico ok"><svg viewBox="0 0 24 24" fill="none" width="28" height="28"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg></div>
                <p class="br-search-title">Inspection complete</p>
                <p class="br-search-sub">${esc(b.artisanName || 'Your professional')} has assessed the problem. Your fixed quote is on its way — we'll notify you.</p>
            </div>`;
        setCta('View my bookings', () => { location.href = 'booking.html'; });

    } else if (st === 'quoted') {
        body.innerHTML = `
            ${rail}
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
            ${rail}
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
    initWhen();
    // Paint the default explicitly rather than relying on the markup's initial
    // aria-checked. restoreDraft() may override it a moment later; this makes
    // sure S.when and the DOM agree either way.
    setWhen('asap', { silent: true });

    $('br-desc').addEventListener('input', (e) => {
        $('br-count').textContent = `${e.target.value.length}/2000`;
        clearFieldError('br-desc');      // the error goes the moment they fix it
        scheduleDraftSave();
    });
    $('br-address').addEventListener('input', () => {
        clearFieldError('br-address');
        scheduleDraftSave();
    });
    $('br-loc-refresh').addEventListener('click', () => detectLocation(true));

    // ── Address autocomplete ─────────────────────────────────────────────────
    // Picking a suggestion resolves BOTH the address text and its coordinates,
    // which matters twice over: the artisan navigates to a place the customer
    // actually chose rather than to wherever they were standing, and a customer
    // whose GPS never resolves can still book — that path used to dead-end at
    // "we need your location".
    //
    // Entirely optional. If the key or the API is unavailable the field behaves
    // exactly as it does today.
    attachAddressAutocomplete($('br-address'), {
        onResolved: ({ address, lat, lng }) => {
            S.lat = lat;
            S.lng = lng;
            S.locPrecise = true;
            S.locLabel = address;
            const line = $('br-loc-line');
            if (line) line.textContent = address;
            clearFieldError('br-address');
            saveDraft();
        },
        onCleared: () => {
            // They edited the box after choosing. Those coordinates described
            // the place they picked, not what is in the field now — keeping
            // them is how an artisan ends up at the previous suggestion.
            if (S.locLabel && $('br-address').value.trim() !== S.locLabel.trim()) {
                S.lat = null; S.lng = null; S.locPrecise = false;
            }
        },
    }).then(a => {
        if (a.available) console.info('[book-request] address autocomplete active');
    }).catch(() => {});
    $('br-cta').addEventListener('click', runCta);
    $('br-back').addEventListener('click', () => {
        if (S.view === 'fee') {
            clearTimeout(S.feeTimer);
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
        // Category handoff. Accepts every token other surfaces actually write:
        //   ?cat=                    dashboard service cards
        //   hh_service_preselect     service-detail / search
        //   hh_service               booking.html "Book again" (_rebook)
        //
        // hh_service was previously ignored entirely — a different key name — so
        // Rebook wrote four keys, none of which were read, and landed the customer
        // on an empty form. resolveCategory() is used rather than an id equality
        // check because these sources write a mix of ids ("plumbing") and display
        // labels ("Plumbing"); matching only ids silently dropped the label form.
        // Bring back whatever they had already written. Restoring FIRST means a
        // deep-linked ?cat= or a chosen professional below still wins — those
        // are a fresh, explicit intent and should override a stale draft.
        const restored = restoreDraft();

        const preToken = params.get('cat')
            || sessionStorage.getItem('hh_service_preselect')
            || sessionStorage.getItem('hh_service');
        const preCat = preToken ? resolveCategory(preToken) : null;
        if (preCat) selectCategory(preCat.id);

        sessionStorage.removeItem('hh_service_preselect');
        sessionStorage.removeItem('hh_service');

        // ── Honour the professional the customer chose ───────────────────────
        //
        // This used to delete hh_selected_artisan without reading it, so every
        // "Book Now" on a specific professional — from their profile, the
        // directory, Saved, the dashboard rail or Rebook — silently became
        // "book anyone", with no notice that the choice had been dropped.
        //
        // The backend supported the choice all along: getPricingQuote takes an
        // artisanId (and prices REAL travel distance from it instead of an
        // estimate), createInspectionBooking carries it onto the booking, and
        // dispatch.js skips dispatch entirely for a pre-matched booking. Only
        // this hand-off was missing.
        try {
            const raw = sessionStorage.getItem('hh_selected_artisan');
            if (raw) {
                const chosen = JSON.parse(raw);
                const id = chosen?.id || chosen?.uid || null;
                if (id) { S.artisanId = String(id); S.artisanName = chosen.name || null; }
            }
        } catch { /* malformed hand-off — fall back to dispatch */ }
        sessionStorage.removeItem('hh_selected_artisan');
        sessionStorage.removeItem('hh_booking_intent');
        switchView('request');
        setCta('See the visit fee', goToFee);
        // Say why the form is already filled in, or it reads as someone else's
        // data. Position is deliberately re-detected rather than restored.
        if (restored) showToast('We kept your unfinished request.');
        detectLocation();
    }
}

window.addEventListener('pagehide', () => {
    if (S.unsub) S.unsub();
    clearTimeout(S.feeTimer);
    // A 400 ms debounce is exactly long enough to lose the last thing they typed
    // before navigating. Flush it.
    if (draftTimer) { clearTimeout(draftTimer); saveDraft(); }
});

init();
