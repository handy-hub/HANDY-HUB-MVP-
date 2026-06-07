/**
 * nearbyPros.js — Nearby Professionals discovery module
 *
 * Architecture
 * ────────────
 * No static imports — all shared dependencies are loaded via resilient dynamic
 * import() so the module evaluates in every serving context (customer-app-only
 * server, project-root server, Firebase Hosting).
 *
 * GPS note: artisan lat/lng fields are written by the presenceService GPS
 * extension (future). When absent the artisan passes the radius check so
 * incomplete profiles are never incorrectly excluded.
 */

'use strict';

/* ── Inlined Haversine (avoids static import on geo.js) ─────────────── */
function haversineKm(lat1, lon1, lat2, lon2) {
  if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) return null;
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Constants ─────────────────────────────────────────────────────────── */
const LOC_CACHE_KEY = 'hh_detected_location';
const ACCRA_LAT     = 5.6037;
const ACCRA_LNG     = -0.1870;
const FETCH_LIMIT   = 50;
const DEBOUNCE_MS   = 120;

const RADIUS_OPTIONS = [
  { label: '2 km',  km: 2   },
  { label: '5 km',  km: 5   },
  { label: '10 km', km: 10  },
  { label: '20 km', km: 20  },
  { label: 'Any',   km: Infinity },
];
const DEFAULT_RADIUS_IDX = 4;  // "Any"

const CATEGORIES = [
  { id: 'all',        label: 'All'        },
  { id: 'Electrical', label: 'Electrical' },
  { id: 'Plumbing',   label: 'Plumbing'   },
  { id: 'Carpentry',  label: 'Carpentry'  },
  { id: 'AC Repair',  label: 'AC Repair'  },
  { id: 'Welding',    label: 'Welding'    },
  { id: 'Painting',   label: 'Painting'   },
  { id: 'Cleaning',   label: 'Cleaning'   },
  { id: 'Gardening',  label: 'Gardening'  },
];

const PRICE_RANGES = {
  Electrical: 'GHC 60–150', Plumbing: 'GHC 50–130',
  Carpentry:  'GHC 70–200', 'AC Repair': 'GHC 80–200',
  Welding:    'GHC 90–250', Painting:   'GHC 80–180',
  Cleaning:   'GHC 50–120', Gardening:  'GHC 40–100',
};

/* ── Module state ──────────────────────────────────────────────────────── */
let _artisans       = null;
let _loading        = false;
let _fetchError     = null;
let _customerLat    = ACCRA_LAT;
let _customerLng    = ACCRA_LNG;
let _hasGps         = false;
let _activeRadius   = RADIUS_OPTIONS[DEFAULT_RADIUS_IDX];
let _activeCategory = 'all';
let _panelOpen      = false;
let _debounceTimer  = null;

let $proList, $distPill, $filterBtn, $panel, $panelOverlay;

/* ── GPS helpers ──────────────────────────────────────────────────────── */
function resolveCustomerGps() {
  try {
    const raw = localStorage.getItem(LOC_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (typeof obj.lat === 'number' && typeof obj.lon === 'number' &&
        isFinite(obj.lat) && isFinite(obj.lon)) {
      _customerLat = obj.lat;
      _customerLng = obj.lon;
      _hasGps      = true;
    }
  } catch (_) {}
}

function distKm(artisan) {
  if (!_hasGps) return null;
  const lat = artisan.lat ?? artisan.latitude  ?? null;
  const lng = artisan.lng ?? artisan.longitude ?? null;
  if (lat === null || lng === null) return null;
  if (!isFinite(Number(lat)) || !isFinite(Number(lng))) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return haversineKm(_customerLat, _customerLng, Number(lat), Number(lng));
}

/* ── Filter ────────────────────────────────────────────────────────────── */
function applyFilters(pool) {
  return pool.filter(a => {
    if (_activeCategory !== 'all') {
      const cat = (a.category || a.serviceType || '').trim();
      if (cat.toLowerCase() !== _activeCategory.toLowerCase()) return false;
    }
    if (isFinite(_activeRadius.km) && _hasGps) {
      const d = distKm(a);
      if (d !== null && d > _activeRadius.km) return false;
    }
    return true;
  });
}

/* ── Dynamic container fetch ───────────────────────────────────────────── */
async function getArtisanRepo() {
  // Resolve module root relative to this file's location
  // Works from project-root server (port 8766) and Firebase Hosting.
  // From a customer-app-only server the import will 404 — caught below.
  const candidatePaths = [
    '../../shared/js/app/container.js',   // customer-app/js/ → shared/
    '../shared/js/app/container.js',       // customer-app/ → shared/  (fallback)
  ];
  for (const path of candidatePaths) {
    try {
      const mod = await import(path);
      const { repositories } = mod.getAppContainer();
      return repositories.artisanRepository;
    } catch (_) { /* try next path */ }
  }
  return null; // shared/ not accessible — skip Firestore fetch
}

/* ── Fetch ─────────────────────────────────────────────────────────────── */
async function fetchArtisans() {
  if (_loading) return;
  _loading    = true;
  _fetchError = null;
  renderSkeleton();
  try {
    const repo = await getArtisanRepo();
    if (!repo) {
      // Running in isolation (customer-app server) — show friendly empty state
      _artisans = [];
    } else {
      const docs  = await repo.getTopRated(FETCH_LIMIT);
      _artisans   = (docs || [])
        .filter(d => d && d.exists !== false && d.data)
        .map(d => ({ id: d.id, ...d.data }));
    }
  } catch (err) {
    console.warn('[nearbyPros] Fetch failed:', err);
    _fetchError = err;
    _artisans   = [];
  } finally {
    _loading = false;
    render();
  }
}

/* ── Avatar ────────────────────────────────────────────────────────────── */
const AVATAR_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23730201'%3E%3Cpath d='M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z'/%3E%3C/svg%3E`;

function avatarSrc(a) {
  return a.profileImage || a.photo || AVATAR_SVG;
}

/* ── HTML escaping ─────────────────────────────────────────────────────── */
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Render: skeleton ──────────────────────────────────────────────────── */
function renderSkeleton() {
  if (!$proList) return;
  $proList.innerHTML = Array(3).fill(0).map(() => `
    <div class="pro-card np-skeleton" aria-hidden="true" style="pointer-events:none;">
      <div class="pc-left">
        <div class="skel skel-circle np-skel-avatar"></div>
        <div class="skel np-skel-badge" style="margin-top:2px;"></div>
      </div>
      <div class="pc-body" style="display:flex;flex-direction:column;gap:6px;">
        <div class="skel np-skel-name"></div>
        <div class="skel np-skel-role"></div>
        <div class="skel np-skel-row"></div>
        <div class="skel np-skel-row2"></div>
      </div>
      <div class="pc-right">
        <div class="skel np-skel-btn"></div>
      </div>
    </div>`).join('');
}

/* ── Render: artisan card ──────────────────────────────────────────────── */
function buildCard(a) {
  const d        = distKm(a);
  const distTxt  = d !== null ? d.toFixed(1) + ' km' : 'Nearby';
  const rating   = Number(a.rating || 0).toFixed(1);
  const reviews  = a.reviewCount  || 0;
  const jobs     = a.jobsCompleted || 0;
  const role     = a.specialty    || a.category || '';
  const online   = a.isOnline === true || a.isAvailable === true;
  const id       = esc(a.id || '');
  const cat      = esc(a.category || '');
  const isTopPro = a.isVerified === true || a.verificationStatus === 'approved';

  const STAR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="#f59e0b" style="flex-shrink:0;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;

  const BRIEFCASE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;"><rect x="2" y="7" width="20" height="14" rx="2" stroke="#bbb" stroke-width="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" stroke="#bbb" stroke-width="2" stroke-linecap="round"/></svg>`;

  const PIN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="#bbb"/></svg>`;

  const CHECK = `<div class="pc-verified" title="Verified"><svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;

  return `<div class="pro-card" data-artisan-id="${id}" onclick="window._npViewArtisan('${id}')">

    <div class="pc-left">
      <div class="pc-avatar-wrap">
        <img class="pc-avatar" src="${esc(avatarSrc(a))}" alt="${esc(a.name || '')}"
             onerror="this.src='${AVATAR_SVG}'">
        ${online ? '<div class="pc-dot"></div>' : ''}
      </div>
      ${isTopPro ? '<span class="pc-top-badge">Top Pro</span>' : ''}
    </div>

    <div class="pc-body">
      <div class="pc-name-row">
        <span class="pc-name">${esc(a.name || 'Professional')}</span>
        ${isTopPro ? CHECK : ''}
      </div>
      ${role ? `<p class="pc-role">${esc(role)}</p>` : ''}
      <div class="pc-rating">
        ${STAR}
        <span class="pc-score">${rating}</span>
        <span class="pc-rcount">(${reviews})</span>
      </div>
      <div class="pc-meta-row">
        <span class="pc-meta-item">${BRIEFCASE}&nbsp;${esc(String(jobs))} jobs</span>
        <span class="pc-meta-sep">·</span>
        <span class="pc-meta-item">${PIN}&nbsp;${esc(distTxt)}</span>
      </div>
    </div>

    <div class="pc-right">
      <button class="pc-book"
        onclick="event.stopPropagation();window._npBookArtisan('${id}','${cat}')">
        Book Now
      </button>
    </div>

  </div>`;
}

/* ── Render: empty state ───────────────────────────────────────────────── */
function buildEmpty() {
  const hasFilter  = _activeCategory !== 'all' || isFinite(_activeRadius.km);
  const catLabel   = _activeCategory !== 'all' ? ` for ${_activeCategory}` : '';
  const distLabel  = isFinite(_activeRadius.km) ? ` within ${_activeRadius.km} km` : '';
  const nextRadius = RADIUS_OPTIONS.find(r => r.km > (_activeRadius.km || 0) && isFinite(r.km))
                   || RADIUS_OPTIONS[RADIUS_OPTIONS.length - 1];

  return `<div class="np-empty" role="status" aria-live="polite">
    <div class="np-empty-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"
              stroke="#730201" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="9" cy="7" r="4" stroke="#730201" stroke-width="1.6"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
              stroke="#730201" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="np-empty-title">No professionals found${catLabel}${distLabel}</p>
    <p class="np-empty-sub">Try expanding your radius or changing your filter.</p>
    <div class="np-empty-actions">
      ${hasFilter && isFinite(nextRadius.km) ? `<button class="np-expand-btn"
          onclick="window._npExpandRadius(${nextRadius.km})">
          Expand to ${nextRadius.label}
        </button>` : ''}
      <button class="np-reset-btn" onclick="window._npResetFilters()">
        Reset Filters
      </button>
    </div>
  </div>`;
}

/* ── Render: error state ────────────────────────────────────────────────── */
function buildError() {
  return `<div class="np-empty" role="alert">
    <div class="np-empty-icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#730201" stroke-width="1.6"/>
        <path d="M12 8v4M12 16h.01" stroke="#730201" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="np-empty-title">Could not load professionals</p>
    <p class="np-empty-sub">Check your connection and try again.</p>
    <button class="np-reset-btn" onclick="window._npRetry()">Retry</button>
  </div>`;
}

/* ── Render: main ──────────────────────────────────────────────────────── */
function render() {
  if (!$proList) return;
  if (_loading)               { renderSkeleton(); return; }
  if (_fetchError)            { $proList.innerHTML = buildError(); return; }
  if (!_artisans)             { $proList.innerHTML = buildError(); return; }

  const matched = applyFilters(_artisans);
  if (matched.length === 0)   { $proList.innerHTML = buildEmpty(); return; }

  const DISPLAY = 8;
  const shown   = matched.slice(0, DISPLAY);
  requestAnimationFrame(() => {
    $proList.innerHTML = shown.map(buildCard).join('') +
      (matched.length > DISPLAY
        ? `<button class="view-more-btn" onclick="window.location.href='book-now.html'">
             Browse All Professionals
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
               <path d="M9 18l6-6-6-6" stroke="#730201" stroke-width="2.5" stroke-linecap="round"/>
             </svg>
           </button>` : '');
  });
}

function scheduleRender() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(render, DEBOUNCE_MS);
}

/* ── Dist-pill label sync ──────────────────────────────────────────────── */
function syncPillLabel() {
  if (!$distPill) return;
  const catPart  = _activeCategory !== 'all' ? ` · ${_activeCategory}` : '';
  const distPart = isFinite(_activeRadius.km) ? `${_activeRadius.km}km` : 'All';
  $distPill.textContent = distPart + catPart;
  $distPill.classList.toggle('dist-pill--active',
    _activeCategory !== 'all' || isFinite(_activeRadius.km));
}

/* ── Filter panel ──────────────────────────────────────────────────────── */
function openPanel() {
  if (!$panel || !$panelOverlay) return;
  _panelOpen = true;
  $panel.classList.add('np-panel--open');
  $panelOverlay.classList.add('np-panel-overlay--open');
  $panel.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closePanel() {
  if (!$panel || !$panelOverlay) return;
  _panelOpen = false;
  $panel.classList.remove('np-panel--open');
  $panelOverlay.classList.remove('np-panel-overlay--open');
  $panel.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function injectPanel() {
  $panelOverlay = document.createElement('div');
  $panelOverlay.className = 'np-panel-overlay';
  $panelOverlay.setAttribute('aria-hidden', 'true');
  $panelOverlay.addEventListener('click', closePanel);

  $panel = document.createElement('div');
  $panel.id = 'np-filter-panel';
  $panel.className = 'np-panel';
  $panel.setAttribute('role', 'dialog');
  $panel.setAttribute('aria-modal', 'true');
  $panel.setAttribute('aria-label', 'Filter professionals');
  $panel.setAttribute('aria-hidden', 'true');

  const radioBtns = RADIUS_OPTIONS.map((r, i) =>
    `<button class="np-radius-chip${i === DEFAULT_RADIUS_IDX ? ' np-chip--active' : ''}"
             data-radius-idx="${i}" aria-pressed="${i === DEFAULT_RADIUS_IDX}">
       ${r.label}
     </button>`).join('');

  const catBtns = CATEGORIES.map(c =>
    `<button class="np-cat-chip${c.id === 'all' ? ' np-chip--active' : ''}"
             data-cat="${esc(c.id)}" aria-pressed="${c.id === 'all'}">
       ${esc(c.label)}
     </button>`).join('');

  $panel.innerHTML = `
    <div class="np-panel-handle"></div>
    <div class="np-panel-header">
      <h3 class="np-panel-title">Filter Professionals</h3>
      <button class="np-panel-close" aria-label="Close filters">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="np-panel-body">
      <p class="np-panel-label">Radius</p>
      <div class="np-chip-row" id="np-radius-chips" role="radiogroup">${radioBtns}</div>
      <p class="np-panel-label" style="margin-top:16px">Category</p>
      <div class="np-chip-row np-chip-row--wrap" id="np-cat-chips" role="group">${catBtns}</div>
    </div>
    <div class="np-panel-footer">
      <button class="np-panel-reset" id="np-panel-reset-btn">Reset</button>
      <button class="np-panel-apply" id="np-panel-apply-btn">Apply Filters</button>
    </div>`;

  document.body.appendChild($panelOverlay);
  document.body.appendChild($panel);

  /* radius chip clicks */
  $panel.querySelector('#np-radius-chips').addEventListener('click', e => {
    const chip = e.target.closest('.np-radius-chip');
    if (!chip) return;
    const idx = Number(chip.dataset.radiusIdx);
    _activeRadius = RADIUS_OPTIONS[idx];
    $panel.querySelectorAll('.np-radius-chip').forEach((c, i) => {
      c.classList.toggle('np-chip--active', i === idx);
      c.setAttribute('aria-pressed', String(i === idx));
    });
  });

  /* category chip clicks */
  $panel.querySelector('#np-cat-chips').addEventListener('click', e => {
    const chip = e.target.closest('.np-cat-chip');
    if (!chip) return;
    _activeCategory = chip.dataset.cat;
    $panel.querySelectorAll('.np-cat-chip').forEach(c => {
      const active = c.dataset.cat === _activeCategory;
      c.classList.toggle('np-chip--active', active);
      c.setAttribute('aria-pressed', String(active));
    });
  });

  $panel.querySelector('.np-panel-close').addEventListener('click', closePanel);

  $panel.querySelector('#np-panel-reset-btn').addEventListener('click', () => {
    _activeRadius   = RADIUS_OPTIONS[DEFAULT_RADIUS_IDX];
    _activeCategory = 'all';
    $panel.querySelectorAll('.np-radius-chip').forEach((c, i) => {
      const active = i === DEFAULT_RADIUS_IDX;
      c.classList.toggle('np-chip--active', active);
      c.setAttribute('aria-pressed', String(active));
    });
    $panel.querySelectorAll('.np-cat-chip').forEach(c => {
      const active = c.dataset.cat === 'all';
      c.classList.toggle('np-chip--active', active);
      c.setAttribute('aria-pressed', String(active));
    });
  });

  $panel.querySelector('#np-panel-apply-btn').addEventListener('click', () => {
    closePanel();
    syncPillLabel();
    scheduleRender();
  });
}

/* ── Global callbacks ──────────────────────────────────────────────────── */
window._npViewArtisan = function (artisanId) {
  const a = (_artisans || []).find(x => x.id === artisanId);
  if (a) {
    sessionStorage.setItem('hh_artisan_view', JSON.stringify({
      id: a.id, uid: a.id,
      name: a.name || '',
      specialty: a.specialty || '',
      category: a.category || '',
      rating: a.rating || 0,
      reviewCount: a.reviewCount || 0,
      jobsCompleted: a.jobsCompleted || 0,
      yearsExperience: a.yearsExperience || null,
      bio: a.bio || '',
      profileImage: a.profileImage || a.photo || null,
      location: a.location || '',
      isAvailable: a.isAvailable || false,
      isOnline: a.isOnline || false,
    }));
  }
  window.location.href = 'artisan-profile.html';
};

window._npBookArtisan = function (artisanId, category) {
  const a = (_artisans || []).find(x => x.id === artisanId);
  if (a) {
    sessionStorage.setItem('hh_selected_artisan', JSON.stringify({
      id: a.id, uid: a.id, name: a.name || '',
      specialty: a.specialty || '', category: a.category || category || '',
      rating: a.rating || 0, reviewCount: a.reviewCount || 0,
      profileImage: a.profileImage || null, location: a.location || '',
    }));
    sessionStorage.setItem('hh_service', a.category || category || '');
  }
  window.location.href = 'book-now.html';
};

window._npResetFilters = function () {
  _activeRadius   = RADIUS_OPTIONS[DEFAULT_RADIUS_IDX];
  _activeCategory = 'all';
  if ($panel) {
    $panel.querySelectorAll('.np-radius-chip').forEach((c, i) => {
      const active = i === DEFAULT_RADIUS_IDX;
      c.classList.toggle('np-chip--active', active);
      c.setAttribute('aria-pressed', String(active));
    });
    $panel.querySelectorAll('.np-cat-chip').forEach(c => {
      const active = c.dataset.cat === 'all';
      c.classList.toggle('np-chip--active', active);
      c.setAttribute('aria-pressed', String(active));
    });
  }
  syncPillLabel();
  scheduleRender();
};

window._npExpandRadius = function (km) {
  const idx = RADIUS_OPTIONS.findIndex(r => r.km === km);
  if (idx === -1) return;
  _activeRadius = RADIUS_OPTIONS[idx];
  if ($panel) {
    $panel.querySelectorAll('.np-radius-chip').forEach((c, i) => {
      const active = i === idx;
      c.classList.toggle('np-chip--active', active);
      c.setAttribute('aria-pressed', String(active));
    });
  }
  syncPillLabel();
  scheduleRender();
};

window._npRetry = function () {
  _artisans = null; _fetchError = null;
  fetchArtisans();
};

/* ── Init ──────────────────────────────────────────────────────────────── */
export function initNearbyPros() {
  $proList   = document.getElementById('np-pro-list');
  $distPill  = document.getElementById('np-dist-pill');
  $filterBtn = document.getElementById('np-filter-btn');

  if (!$proList) return;

  resolveCustomerGps();
  syncPillLabel();
  renderSkeleton();
  injectPanel();

  $distPill?.addEventListener('click', openPanel);
  $filterBtn?.addEventListener('click', openPanel);

  fetchArtisans();

  window.addEventListener('storage', e => {
    if (e.key !== LOC_CACHE_KEY) return;
    resolveCustomerGps();
    syncPillLabel();
    scheduleRender();
  });
}
