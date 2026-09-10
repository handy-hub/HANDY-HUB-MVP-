/**
 * placesService.js — turn a typed address into a real place with coordinates.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `br-address` is free text. "my house near the junction" is accepted, and the
 * coordinates stored on the booking come from `getCurrentPosition()` — wherever
 * the customer happened to be standing when they filled the form. The artisan
 * navigates to those coordinates. Those two facts can disagree, and when they
 * do somebody drives to the wrong door.
 *
 * Worse: bookRequestPage refuses to submit without a GPS fix (see the
 * `S.locPrecise` checks). A customer indoors with no signal simply cannot book.
 * Resolving the typed address supplies coordinates itself, so that dead end
 * disappears.
 *
 * WHY A CUSTOM DROPDOWN AND NOT GOOGLE'S WIDGET
 * ─────────────────────────────────────────────
 * `PlaceAutocompleteElement` replaces the input with its own custom element.
 * `br-address` carries the page's styling, its draft-restore logic reads
 * `.value`, and validation reads it by id — swapping the element out breaks all
 * three. So this uses the Places **Data** API and renders suggestions itself,
 * leaving the input exactly where it was.
 *
 * FAILING HONESTLY
 * ────────────────
 * Every failure path here leaves the field as ordinary free text, exactly as it
 * behaves today. No key, offline, API refused, no results — the customer can
 * still type an address and book. Autocomplete is an improvement layered on top,
 * never a gate in front.
 */

import { MAPS_API_KEY } from '../config/appConfig.js';

const GH_BOUNDS = { north: 11.2, south: 4.5, east: 1.3, west: -3.3 };

let _loader = null;

/** Load the Maps JS API once per document. Resolves null if unavailable. */
function loadMaps() {
    if (_loader) return _loader;

    if (!MAPS_API_KEY) {
        _loader = Promise.resolve(null);
        return _loader;
    }
    if (window.google?.maps?.places?.AutocompleteSuggestion) {
        _loader = Promise.resolve(window.google.maps);
        return _loader;
    }

    _loader = new Promise((resolve) => {
        const s = document.createElement('script');
        s.async = true;
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_API_KEY)}`
              + '&libraries=places&v=weekly';
        // Wait for the places library itself. `importLibrary` is part of the
        // bootstrap-loader pattern and appears only intermittently behind a
        // plain script tag — depending on it produced "importLibrary is not a
        // function" on some loads and worked on others. `libraries=places`
        // loads it eagerly, so this is the thing that actually has to exist.
        s.onload = async () => {
            for (let i = 0; i < 60; i++) {
                if (window.google?.maps?.places?.AutocompleteSuggestion) {
                    resolve(window.google.maps);
                    return;
                }
                await new Promise(r => setTimeout(r, 50));
            }
            console.warn('[places] Maps loaded but the places library never appeared.');
            resolve(null);
        };
        s.onerror = () => {
            // Usually a referrer restriction rejecting this origin. Not fatal.
            console.warn('[places] Maps JS failed to load — address stays free text.');
            resolve(null);
        };
        document.head.appendChild(s);
    });
    return _loader;
}

/**
 * Attach address autocomplete to an existing text input.
 *
 * @param {HTMLInputElement} input
 * @param {object}   opts
 * @param {Function} opts.onResolved  ({ address, lat, lng, placeId }) => void
 * @param {Function} [opts.onCleared] () => void — fired when the user edits away
 *                                    from a resolved place, so the caller can
 *                                    drop stale coordinates rather than keep
 *                                    coordinates for an address nobody picked.
 * @returns {Promise<{ destroy: Function, available: boolean }>}
 */
export async function attachAddressAutocomplete(input, opts = {}) {
    const { onResolved, onCleared } = opts;
    const noop = { destroy() {}, available: false };
    if (!input) return noop;

    const maps = await loadMaps();
    if (!maps) return noop;

    const places = maps.places || {};
    const AutocompleteSuggestion     = places.AutocompleteSuggestion;
    const AutocompleteSessionToken   = places.AutocompleteSessionToken;
    if (!AutocompleteSuggestion?.fetchAutocompleteSuggestions) {
        console.warn('[places] AutocompleteSuggestion unavailable — address stays free text.');
        return noop;
    }

    // ── Dropdown ─────────────────────────────────────────────────────────────
    const box = document.createElement('div');
    box.className = 'hh-places';
    box.setAttribute('role', 'listbox');
    box.hidden = true;
    if (getComputedStyle(input.parentElement).position === 'static') {
        input.parentElement.style.position = 'relative';
    }
    input.parentElement.appendChild(box);
    input.setAttribute('autocomplete', 'off');       // ours, not the browser's

    injectStyles();

    let token = new AutocompleteSessionToken();
    let items = [];
    let active = -1;
    let debounce = null;
    let resolved = false;

    const close = () => { box.hidden = true; active = -1; };

    const render = () => {
        if (!items.length) { close(); return; }
        box.innerHTML = items.map((it, i) => `
            <button type="button" class="hh-place${i === active ? ' active' : ''}"
                    role="option" data-i="${i}">
              <span class="hh-place-main">${escapeHtml(it.main)}</span>
              <span class="hh-place-sub">${escapeHtml(it.secondary)}</span>
            </button>`).join('');
        box.hidden = false;
    };

    async function choose(i) {
        const it = items[i];
        if (!it) return;
        try {
            const place = it.suggestion.toPlace();
            await place.fetchFields({ fields: ['location', 'formattedAddress', 'displayName'] });
            const loc = place.location;
            const lat = typeof loc?.lat === 'function' ? loc.lat() : loc?.lat;
            const lng = typeof loc?.lng === 'function' ? loc.lng() : loc?.lng;

            // A place without coordinates is useless to us — it is exactly the
            // ambiguity we are removing. Leave the text, report nothing.
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) { close(); return; }

            input.value = place.formattedAddress || it.main;
            resolved = true;
            close();
            token = new AutocompleteSessionToken();   // session ends on selection
            onResolved?.({
                address: input.value,
                lat, lng,
                placeId: place.id || null,
            });
        } catch (e) {
            console.warn('[places] could not resolve place:', e?.message || e);
            close();
        }
    }

    async function search(q) {
        if (q.trim().length < 3) { items = []; close(); return; }
        try {
            const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
                input: q,
                sessionToken: token,
                includedRegionCodes: ['gh'],
                locationRestriction: GH_BOUNDS,
            });
            items = (suggestions || []).slice(0, 5).map(s => {
                const p = s.placePrediction;
                return {
                    suggestion: p,
                    main:      p?.mainText?.text || p?.text?.text || '',
                    secondary: p?.secondaryText?.text || '',
                };
            }).filter(x => x.main);
            render();
        } catch (e) {
            // Quota, referrer rejection, offline. The field keeps working as
            // plain text either way, but say why once so a misconfigured key is
            // diagnosable instead of looking like "autocomplete just does nothing".
            if (!search._warned) {
                search._warned = true;
                console.warn('[places] suggestions unavailable:', e?.message || e);
            }
            items = []; close();
        }
    }

    const onInput = () => {
        if (resolved) {
            // They typed after picking — the old coordinates no longer describe
            // what is in the box.
            resolved = false;
            onCleared?.();
        }
        clearTimeout(debounce);
        debounce = setTimeout(() => search(input.value), 220);
    };

    const onKeyDown = (e) => {
        if (box.hidden || !items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
        else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
        else if (e.key === 'Escape') close();
    };

    const onBoxClick = (e) => {
        const btn = e.target.closest('[data-i]');
        if (btn) choose(Number(btn.dataset.i));
    };

    const onDocClick = (e) => { if (!box.contains(e.target) && e.target !== input) close(); };

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeyDown);
    box.addEventListener('mousedown', (e) => e.preventDefault());  // keep focus
    box.addEventListener('click', onBoxClick);
    document.addEventListener('click', onDocClick);

    return {
        available: true,
        destroy() {
            clearTimeout(debounce);
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('click', onDocClick);
            box.remove();
        },
    };
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let _styled = false;
function injectStyles() {
    if (_styled) return;
    _styled = true;
    const st = document.createElement('style');
    st.textContent = `
    .hh-places {
      position: absolute; left: 0; right: 0; top: calc(100% + 4px);
      background: var(--ui-surface, #fff);
      border: 1px solid var(--ui-border, #E2E5EA);
      border-radius: 12px; overflow: hidden; z-index: 60;
      box-shadow: 0 8px 24px rgba(15,18,22,.12);
    }
    .hh-places[hidden] { display: none; }
    .hh-place {
      display: block; width: 100%; text-align: left; border: none; cursor: pointer;
      background: transparent; padding: 11px 14px;
      border-bottom: 1px solid var(--ui-border, #EFF1F4);
      font-family: inherit;
    }
    .hh-place:last-child { border-bottom: none; }
    .hh-place.active, .hh-place:hover { background: var(--ui-surface-2, #F5F7FA); }
    .hh-place-main { display: block; font-size: 14px; font-weight: 600; color: var(--ui-text, #0F1216); }
    .hh-place-sub  { display: block; font-size: 12px; color: var(--ui-text-3, #8A93A6); margin-top: 1px; }`;
    document.head.appendChild(st);
}
