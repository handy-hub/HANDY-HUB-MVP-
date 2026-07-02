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
 * Each banner's `action` field fully controls where a tap/click navigates.
 * Supported action types:
 *   'service'  → opens the service-detail (research) page for that category
 *   'artisan'  → stores artisan object then goes to artisan-profile.html
 *   'route'    → navigates to any internal page (action.payload.url)
 *   'external' → opens a URL in a new tab (action.payload.url)
 *   'promo'    → stores a promo code then goes to action.payload.url
 *   'category' → stores browse category then goes to browse.html
 */
import { resolveCategory } from '../../shared/js/data/serviceCatalog.js';
import {
  loadActivePromotions, resolveImage, resolvePromotions,
  trackPromotionImpression, trackPromotionClick,
} from '../../shared/js/services/promotionService.js';

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
    action: {
      type: 'route',
      payload: { url: 'book-step1.html' },
    },
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
    action: {
      type: 'service',
      payload: { service: 'Cleaning' },
    },
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
    action: {
      type: 'service',
      payload: { service: 'AC Repair' },
    },
  },
];

/* ═══════════════════════════════════════════════════
   FIRESTORE ADAPTER
   Maps the strict promotions/{id} schema (content/media/action/…) onto the
   exact shape renderSlide()/resolveAction() already expect (title/subtitle/
   image/action.payload/…), so the rendering and navigation code below never
   needs to know whether a slide came from Firestore or BANNER_DATA.
═══════════════════════════════════════════════════ */
function adaptPromotion(promo) {
  const content  = promo.content  ?? {};
  const media    = promo.media    ?? {};
  const action   = promo.action   ?? {};
  const value    = action.value ?? '';

  // Map the single flat `action.value` onto the payload shape resolveAction()
  // already reads per type — this is the only place that knows both shapes.
  const PAYLOAD_BY_TYPE = {
    service:  { service: value },
    artisan:  { id: value },
    route:    { url: value },
    external: { url: value },
    promo:    { code: value, url: value },
    category: { category: value, url: value },
  };

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
    action: { type: action.type, payload: PAYLOAD_BY_TYPE[action.type] ?? {} },
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
  const fetchResult = await loadActivePromotions();        // Stage 1 — never throws
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

  switch (action.type) {
    case 'service': {
      const { service, task } = action.payload ?? {};
      if (service) sessionStorage.setItem('hh_service', service);
      if (task)    sessionStorage.setItem('hh_task', task);
      // Promo/recommendation → land on the service-detail (research) page so the
      // customer can see what's included and the price before committing.
      const cat = resolveCategory(service);
      window.location.href = cat
        ? `service-detail.html?cat=${encodeURIComponent(cat.id)}`
        : 'book-step1.html';
      break;
    }
    case 'artisan': {
      if (action.payload) {
        sessionStorage.setItem('hh_artisan_view', JSON.stringify(action.payload));
      }
      window.location.href = 'artisan-profile.html';
      break;
    }
    case 'route': {
      const url = action.payload?.url;
      if (url) window.location.href = url;
      break;
    }
    case 'external': {
      const url = action.payload?.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      break;
    }
    case 'promo': {
      const { code, url } = action.payload ?? {};
      if (code) sessionStorage.setItem('hh_promo', code);
      window.location.href = url ?? 'book-step1.html';
      break;
    }
    case 'category': {
      const cat = action.payload?.category;
      if (cat) sessionStorage.setItem('hh_browse_category', cat);
      window.location.href = action.payload?.url ?? 'browse.html';
      break;
    }
    default:
      console.warn('[adBanner] Unknown action type:', action.type);
  }
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
      <div class="slide-img-wrap" style="--img-fallback:${banner.color ?? '#e8e8e8'}">
        <img src="${banner.image}" alt="${banner.tag}"
             loading="eager" decoding="async"${index === 0 ? ' fetchpriority="high"' : ''}
             draggable="false">
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
export async function mountAdBanner(containerEl, dotsEl, banners = null, user = null) {
  if (!containerEl) return;
  if (!banners) banners = await loadBanners(user);
  if (!banners.length) return;

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
