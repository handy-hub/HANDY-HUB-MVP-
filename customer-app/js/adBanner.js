/**
 * adBanner.js — Data-driven promotional banner system
 *
 * Data source: Firestore "promotions" collection (see promotionService.js),
 * filtered/targeted/capped by resolvePromotions(). If Firestore fails,
 * returns no results, or the user has no session, this falls back to the
 * hardcoded BANNER_DATA below unconditionally — the carousel must never
 * render blank. See loadBanners() for the exact fallback sequence.
 *
 * TO ADD / REMOVE / EDIT THE FALLBACK BANNERS: change BANNER_DATA only.
 * Live promotions are managed in Firestore (promotions collection), not here.
 *
 * Each banner's `action` ({ type, value }) controls where a tap navigates. The
 * canonical destination + validation for EVERY type lives in one shared contract —
 * shared/js/domain/promotionAction.js — also imported by the admin editor, so the
 * two can never disagree. resolveAction() below only executes that contract.
 *   'service' / 'category' → book-request.html?cat=<id> (discovery/booking entry)
 *   'artisan'              → artisan-profile.html (sets hh_artisan_view)
 *   'route'                → a known internal page (validated against the registry)
 *   'external'             → opens an http(s) URL in a new tab
 *   'promo'                → sets hh_promo, then book-request.html
 */
import { promotionActionTarget } from '../../shared/js/domain/promotionAction.js';
import {
  loadActivePromotions, resolveImage, resolvePromotions,
  trackPromotionImpression, trackPromotionClick,
} from '../../shared/js/services/promotionService.js';
import { readCache, writeCache } from '../../shared/js/services/persistentCache.js';

/* ═══════════════════════════════════════════════════
   BANNER DATA  ←  edit here to manage promotions
═══════════════════════════════════════════════════ */
export const BANNER_DATA = [
  {
    id: 'promo-discount',
    tag: 'Limited Time',
    title: 'Get 20% OFF',
    subtitle: 'Your first booking',
    body: 'Trusted professionals, quality service.',
    cta: 'Book Now',
    color: 'linear-gradient(135deg, #4a8cc9 0%, #1e5a9a 100%)',
    image: 'https://i.pinimg.com/736x/44/41/9d/44419dac4fcb78aae208565099c97221.jpg',
    clients: {
      count: '500+',
      label: 'Happy clients',
      avatars: [
        { initial: 'K', color: '#4A90D9' },
        { initial: 'A', color: '#E8703A' },
        { initial: 'M', color: '#2ECC71' },
      ],
    },
    action: { type: 'route', value: 'book-request.html' },
  },
  {
    id: 'promo-cleaning',
    tag: 'Home Cleaning',
    title: 'Express Clean',
    subtitle: 'Sparkling results',
    body: 'Book a pro cleaner in under 2 minutes.',
    cta: 'Check Rates',
    color: 'linear-gradient(135deg, #3db87a 0%, #1a8a52 100%)',
    image: 'https://i.pinimg.com/736x/04/1a/09/041a0923ce2a5d512923d1cdffcd7e1f.jpg',
    clients: {
      count: '200+',
      label: 'Happy clients',
      avatars: [
        { initial: 'E', color: '#9B59B6' },
        { initial: 'F', color: '#E74C3C' },
        { initial: 'B', color: '#1ABC9C' },
      ],
    },
    action: { type: 'service', value: 'Cleaning' },
  },
  {
    id: 'promo-ac',
    tag: 'New Service',
    title: 'AC Repair',
    subtitle: 'Stay cool always',
    body: 'Expert technicians at your doorstep.',
    cta: 'Fix Now',
    color: 'linear-gradient(135deg, #f0844a 0%, #c45520 100%)',
    image: 'https://i.pinimg.com/736x/84/fa/24/84fa2444f8cc33ef30c8813e95807bb6.jpg',
    clients: {
      count: '300+',
      label: 'Happy clients',
      avatars: [
        { initial: 'O', color: '#E67E22' },
        { initial: 'S', color: '#2980B9' },
        { initial: 'J', color: '#27AE60' },
      ],
    },
    action: { type: 'service', value: 'AC Repair' },
  },
];

/* ═══════════════════════════════════════════════════
   FIRESTORE ADAPTER
   Maps the strict promotions/{id} schema (content/media/action/…) onto the
   exact shape renderSlide()/resolveAction() already expect (title/subtitle/
   image/action {type,value}/…), so the rendering and navigation code below never
   needs to know whether a slide came from Firestore or BANNER_DATA.
═══════════════════════════════════════════════════ */
function adaptPromotion(promo) {
  const content  = promo.content  ?? {};
  const media    = promo.media    ?? {};
  const action   = promo.action   ?? {};

  return {
    id: promo.id,
    tag: content.tag ?? '',
    title: content.title ?? '',
    subtitle: content.subtitle ?? '',
    body: content.body ?? '',
    cta: content.cta ?? 'Learn More',
    color: promo.color ?? 'linear-gradient(135deg, #4a8cc9 0%, #1e5a9a 100%)',
    image: resolveImage(media.imageKey),
    clients: promo.clients ?? null,
    // Canonical {type, value} — the SAME shape BANNER_DATA and the admin editor use.
    // What each type resolves to is owned by promotionActionTarget() (one contract).
    action: { type: action.type, value: action.value ?? '' },
    _isPromotion: true, // marks a Firestore-sourced slide for analytics tracking
  };
}

/* ═══════════════════════════════════════════════════
   LOAD BANNERS  — explicit 5-stage pipeline, Firestore-first with a
   deterministic BANNER_DATA fallback. NEVER throws, NEVER resolves to an
   empty array — mountAdBanner() always gets at least the hardcoded
   fallback slides to render.

   Stage 1 Fetch      loadActivePromotions()   → PromotionLoadResult
   Stage 2 Normalize  adaptPromotion()         → (applied per-item, Stage 4)
   Stage 3 Filter     resolvePromotions()      → targeted array
   Stage 4 State      resolveLoadState()       → { status, reason }
   Stage 5 Fallback   decided from status ALONE, never from array length
═══════════════════════════════════════════════════ */

/**
 * Stage 4 — turn a fetch result + filter result into one explicit state.
 * The fallback decision (Stage 5, in loadBanners()) reads ONLY `.status`,
 * never re-inspects array lengths — `reason` exists purely for logging.
 * @returns {{status: "success"|"empty", reason: "network"|"no_docs"|"filtered_out"|null}}
 */
function resolveLoadState(fetchResult, targeted) {
  if (fetchResult.status === 'error') {
    return { status: 'error', reason: 'network' };
  }
  if (fetchResult.status === 'empty') {
    return { status: 'empty', reason: 'no_docs' };
  }
  // fetchResult.status === 'success' (Firestore had active docs) but targeting
  // may still have excluded all of them for this particular user.
  if (targeted.length === 0) {
    return { status: 'empty', reason: 'filtered_out' };
  }
  return { status: 'success', reason: null };
}

async function loadBanners(user) {
  const loaded = await loadActivePromotions();             // Stage 1 — never throws
  // Accept legacy/bad cached loader results without crashing the carousel.
  const fetchResult = Array.isArray(loaded)
    ? { status: loaded.length ? 'success' : 'empty', data: loaded, reason: loaded.length ? null : 'no_docs' }
    : (loaded && typeof loaded === 'object')
      ? { ...loaded, data: Array.isArray(loaded.data) ? loaded.data : [] }
      : { status: 'error', data: [], reason: 'network' };
  const targeted     = resolvePromotions(user, fetchResult.data); // Stage 3
  const state         = resolveLoadState(fetchResult, targeted);  // Stage 4

  // Stage 5 — fallback decided from status only, per the strict rule:
  // "status === error OR status === empty" → BANNER_DATA, regardless of
  // WHY it's empty (no_docs vs filtered_out are not distinguished here).
  if (state.status !== 'success') {
    console.info(`[adBanner] Using fallback banners (status=${state.status}, reason=${state.reason}).`);
    return BANNER_DATA;
  }
  return targeted.map(adaptPromotion); // Stage 2 applied here, only on the success path
}

/* ═══════════════════════════════════════════════════
   NAVIGATION RESOLVER
   Reads the banner's action object — never hard-codes a URL.
═══════════════════════════════════════════════════ */
export function resolveAction(action) {
  if (!action?.type) return;
  // ONE contract owns every destination decision (shared with the admin editor):
  // shared/js/domain/promotionAction.js. This function only executes the result —
  // set the session context it asks for, then navigate.
  const { url, newTab, session } = promotionActionTarget(action);
  try {
    Object.entries(session).forEach(([k, v]) => sessionStorage.setItem(k, v));
  } catch (_) { /* storage blocked — navigation still proceeds */ }
  if (newTab) window.open(url, '_blank', 'noopener,noreferrer');
  else        window.location.href = url;
}

/* ═══════════════════════════════════════════════════
   SLIDE RENDERER  — pure function, no side-effects
═══════════════════════════════════════════════════ */
function renderSlide(banner, index) {
  const avatarHTML = (banner.clients?.avatars ?? [])
    .map(av => `<div class="client-av" style="background:${av.color}">${av.initial}</div>`)
    .join('');

  const clientsHTML = banner.clients ? `
    <div class="slide-clients">
      <div class="client-avatars">${avatarHTML}</div>
      <div class="client-count">
        <strong>${banner.clients.count}</strong>
        <span>${banner.clients.label}</span>
      </div>
    </div>` : '';

  /* The entire .slide is role="button" — no nested <button> to avoid a11y issues */
  return `
    <div class="slide"
         data-banner-id="${banner.id}"
         data-banner-index="${index}"
         role="button"
         tabindex="0"
         aria-label="${banner.title} — ${banner.cta}">
      <div class="slide-content">
        <span class="ad-tag">${banner.tag}</span>
        <div class="slide-headline">
          <p class="slide-title">${banner.title}</p>
          <p class="slide-sub">${banner.subtitle}</p>
          <p class="slide-body">${banner.body}</p>
        </div>
        <div class="slide-bottom">
          <span class="banner-cta" aria-hidden="true">
            ${banner.cta}
            <span class="arrow-icon">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none">
                <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
              </svg>
            </span>
          </span>
          ${clientsHTML}
        </div>
      </div>
      <div class="slide-img-wrap${banner.image ? '' : ' img-failed'}" style="--img-fallback:${banner.color ?? '#e8e8e8'}">
        ${banner.image ? `<img src="${banner.image}" alt="${banner.tag}"
             loading="eager" decoding="async"${index === 0 ? ' fetchpriority="high"' : ''}
             draggable="false">` : ''}
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════
   MOUNT  — call once per page that uses the banner
   Async data source: if `banners` is omitted, this loads live Firestore
   promotions (targeted for `user` if provided) and falls back to
   BANNER_DATA automatically — see loadBanners() above. Passing an explicit
   `banners` array (as before) skips the Firestore fetch entirely, so
   existing/future synchronous callers are unaffected.
═══════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════
   PERSISTENT SWR CACHE for the resolved banner payload.
   The customer app is multi-page: a fresh document loads on every navigation,
   wiping all in-memory state — so WITHOUT a navigation-surviving cache the
   banner re-shimmers, re-reads Firestore, and rebuilds on every dashboard visit
   (the "banner flash"). We store the resolved slides in persistentCache and
   instant-paint them (no shimmer, single mount), then revalidate quietly.
   This mirrors the pattern nearbyPros.js + the dashboard profile paint already
   use. Promotions are non-sensitive marketing data — never financial/booking.
═══════════════════════════════════════════════════ */
const BANNER_CACHE_KEY     = 'promotions';
// v2 invalidates payloads written before the Firestore loader compatibility fix.
const BANNER_CACHE_VERSION = 2;
const BANNER_STALE_MS      = 60_000;        // < 60s old → skip the network entirely (0 reads)
const BANNER_TTL_MS        = 10 * 60_000;   // usable-from-cache window; revalidate when older

/** Scope the cache by the authenticated uid (promo targeting is per-user),
 *  resolved the same way the dashboard profile paint does. */
function resolveBannerUid(user) {
  try {
    const w = (typeof window !== 'undefined') ? window : globalThis.window;
    if (w?.HH_State?.currentUid?.()) return w.HH_State.currentUid();
    const last = w?.localStorage?.getItem('hh_last_session_uid');
    if (last) return last;
  } catch { /* storage blocked */ }
  return user?.uid ?? user?.id ?? null;
}

/** The 4th arg may be a user object OR a lazy async provider. The provider is
 *  invoked ONLY when a real fetch is needed, so a warm cache does ZERO reads. */
async function resolveUser(userOrProvider) {
  try {
    return (typeof userOrProvider === 'function' ? await userOrProvider() : userOrProvider) || null;
  } catch { return null; }
}

/**
 * Mount the promo carousel. 4th arg accepts a user object OR a lazy provider fn.
 * Stale-while-revalidate: paint a navigation-surviving cache instantly (no
 * shimmer), and only touch Firestore when the cache is stale or absent.
 */
export async function mountAdBanner(containerEl, dotsEl, banners = null, userOrProvider = null) {
  if (!containerEl) return;

  // Explicit banners array passed in → legacy synchronous path, unchanged.
  if (banners) {
    if (banners.length) renderAndWire(containerEl, dotsEl, banners);
    return;
  }

  const uid = resolveBannerUid(typeof userOrProvider === 'function' ? null : userOrProvider);
  const cached = readCache(BANNER_CACHE_KEY, {
    uid, version: BANNER_CACHE_VERSION, ttlMs: BANNER_TTL_MS, storage: 'local',
  });

  // ── Warm path — instant paint from a navigation-surviving cache ──────────
  if (cached && Array.isArray(cached.data) && cached.data.length) {
    renderAndWire(containerEl, dotsEl, cached.data);   // no shimmer, single mount
    if (cached.ageMs < BANNER_STALE_MS) return;        // fresh enough → 0 reads
    // Stale-but-usable: revalidate for the NEXT visit only. We do NOT re-render
    // now — that would re-wire listeners and reintroduce a flash. Fresh promos
    // appear on the next dashboard load.
    resolveUser(userOrProvider)
      .then((u) => loadBanners(u))
      .then((fresh) => {
        if (Array.isArray(fresh) && fresh.some((banner) => banner?._isPromotion)) {
          writeCache(BANNER_CACHE_KEY, fresh, {
            uid, version: BANNER_CACHE_VERSION, storage: 'local',
          });
        }
      })
      .catch(() => {});
    return;
  }

  // ── Cold path — no usable cache: shimmer → fetch → mount → cache ─────────
  containerEl.classList.add('ads-loading');
  const user  = await resolveUser(userOrProvider);
  const loaded = await loadBanners(user);
  const fresh = Array.isArray(loaded) && loaded.length ? loaded : BANNER_DATA;
  containerEl.classList.remove('ads-loading');
  // Never persist the hardcoded fallback. Caching "no eligible promotions"
  // made a newly activated Firestore promotion remain invisible until expiry.
  // Real promotion payloads still retain the normal SWR performance path.
  if (fresh.some((banner) => banner?._isPromotion)) {
    writeCache(BANNER_CACHE_KEY, fresh, {
      uid: resolveBannerUid(user), version: BANNER_CACHE_VERSION, storage: 'local',
    });
  }
  renderAndWire(containerEl, dotsEl, fresh);
}

/* ═══════════════════════════════════════════════════
   RENDER + WIRE  — build the slides and attach the carousel behaviour.
   Called EXACTLY ONCE per mountAdBanner (from cache OR from a fresh fetch,
   never both) so its document/window listeners are never duplicated.
═══════════════════════════════════════════════════ */
function renderAndWire(containerEl, dotsEl, banners) {
  const sliderEl = containerEl.querySelector('.slider');
  if (!sliderEl) return;

  const n = banners.length;

  /* ── Render slides ── */
  sliderEl.innerHTML = banners.map((b, i) => renderSlide(b, i)).join('');

  /* ── Size slides to the container's pixel width ──
     Percentage widths break here because the slider itself is the flex parent
     and CSS can't resolve self-referential percentages. Use px instead.      */
  function applyWidths() {
    /* getBoundingClientRect is sub-pixel accurate and works when offsetWidth is
       still 0 during certain paint phases (e.g. inside a CSS transition).      */
    const w = Math.round(containerEl.getBoundingClientRect().width)
           || containerEl.offsetWidth
           || 320; // absolute fallback so the slider is never invisible
    sliderEl.style.width = `${n * w}px`;
    sliderEl.querySelectorAll('.slide').forEach(s => {
      s.style.width      = `${w}px`;
      s.style.flexShrink = '0';
    });
    return w;
  }
  let slideWidth = applyWidths();

  /* ── Render dots ── */
  if (dotsEl) {
    dotsEl.innerHTML = banners
      .map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}"></span>`)
      .join('');
  }

  /* ── Image fallback — handle CDN failures (403, CORS, stale URLs) gracefully ── */
  sliderEl.querySelectorAll('.slide-img-wrap').forEach(wrap => {
    const img = wrap.querySelector('img');
    if (!img) return;
    img.addEventListener('error', () => wrap.classList.add('img-failed'), { once: true });
    // Catch images that already failed before this handler was attached (cached error)
    if (img.complete && img.naturalWidth === 0) wrap.classList.add('img-failed');
  });

  /* ── Accessibility ── */
  containerEl.setAttribute('aria-roledescription', 'carousel');
  containerEl.setAttribute('aria-label', 'Promotional offers');
  if (dotsEl) dotsEl.setAttribute('aria-label', 'Slide indicators');

  /* ── State ── */
  let current = 0;
  let timer   = null;
  const INTERVAL = 5000;
  const _trackedImpressions = new Set(); // one impression per slide per mount, not per re-view

  function goTo(index) {
    current = ((index % n) + n) % n;
    sliderEl.style.transform = `translateX(-${current * slideWidth}px)`;
    if (dotsEl) {
      dotsEl.querySelectorAll('.dot').forEach((d, i) =>
        d.classList.toggle('active', i === current)
      );
    }
    const shown = banners[current];
    if (shown?._isPromotion && !_trackedImpressions.has(shown.id)) {
      _trackedImpressions.add(shown.id);
      trackPromotionImpression(shown.id); // fire-and-forget, never blocks the transition
    }
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => goTo(current + 1), INTERVAL);
  }

  function stopTimer() {
    clearInterval(timer);
  }

  /* ── Pause on hover (desktop) ── */
  containerEl.addEventListener('mouseenter', stopTimer);
  containerEl.addEventListener('mouseleave', startTimer);

  /* ── Touch swipe ── */
  let touchStartX = 0;
  let isDragging  = false;

  sliderEl.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    isDragging  = false;
    stopTimer();
  }, { passive: true });

  sliderEl.addEventListener('touchmove', e => {
    if (Math.abs(e.touches[0].clientX - touchStartX) > 8) isDragging = true;
  }, { passive: true });

  sliderEl.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (isDragging && Math.abs(dx) > 40) goTo(current + (dx < 0 ? 1 : -1));
    startTimer();
  }, { passive: true });

  /* ── Click: entire card navigates ── */
  sliderEl.addEventListener('click', e => {
    if (isDragging) return;             // was a swipe, not a tap
    const slide = e.target.closest('.slide');
    if (!slide) return;
    const banner = banners[parseInt(slide.dataset.bannerIndex, 10)];
    if (banner?._isPromotion) trackPromotionClick(banner.id); // fire-and-forget
    if (banner?.action) resolveAction(banner.action);
  });

  /* ── Keyboard: Enter / Space on focused slide ── */
  sliderEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const slide = e.target.closest('.slide');
    if (!slide) return;
    e.preventDefault();
    const banner = banners[parseInt(slide.dataset.bannerIndex, 10)];
    if (banner?._isPromotion) trackPromotionClick(banner.id); // fire-and-forget
    if (banner?.action) resolveAction(banner.action);
  });

  /* ── Dot clicks ── */
  if (dotsEl) {
    dotsEl.addEventListener('click', e => {
      const dot = e.target.closest('.dot');
      if (!dot) return;
      const idx = [...dotsEl.querySelectorAll('.dot')].indexOf(dot);
      if (idx >= 0) { stopTimer(); goTo(idx); startTimer(); }
    });
  }

  /* ── Pause when the tab is hidden (saves CPU / battery, prevents timer drift) ── */
  document.addEventListener('visibilitychange', () => {
    document.hidden ? stopTimer() : startTimer();
  });

  /* ── Re-sync on resize / orientation change ── */
  window.addEventListener('resize', () => {
    slideWidth = applyWidths();
    sliderEl.style.transition = 'none';        // snap instantly on resize
    goTo(current);
    requestAnimationFrame(() => {
      sliderEl.style.transition = '';           // re-enable smooth transitions
    });
  }, { passive: true });

  /* ── Boot ── */
  goTo(0);
  startTimer();
}
