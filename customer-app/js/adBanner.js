/**
 * adBanner.js — Data-driven promotional banner system
 *
 * TO ADD / REMOVE / EDIT A BANNER: change BANNER_DATA only. Zero HTML edits needed.
 * TO GO LIVE WITH FIRESTORE:       replace loadBanners() with a Firestore query and
 *                                  pass the result array into mountAdBanner().
 *
 * Each banner's `action` field fully controls where a tap/click navigates.
 * Supported action types:
 *   'service'  → sets hh_service (+ optional hh_task) then goes to book-now.html
 *   'artisan'  → stores artisan object then goes to artisan-profile.html
 *   'route'    → navigates to any internal page (action.payload.url)
 *   'external' → opens a URL in a new tab (action.payload.url)
 *   'promo'    → stores a promo code then goes to action.payload.url
 *   'category' → stores browse category then goes to browse.html
 */

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
      window.location.href = 'book-now.html';
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
      <div class="slide-img-wrap">
        <img src="${banner.image}" alt="${banner.tag}" loading="lazy" draggable="false">
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════
   MOUNT  — call once per page that uses the banner
═══════════════════════════════════════════════════ */
export function mountAdBanner(containerEl, dotsEl, banners = BANNER_DATA) {
  if (!containerEl || !banners.length) return;

  const sliderEl = containerEl.querySelector('.slider');
  if (!sliderEl) return;

  const n = banners.length;

  /* ── Render slides ── */
  sliderEl.innerHTML = banners.map((b, i) => renderSlide(b, i)).join('');

  /* ── Size slides to the container's pixel width ──
     Percentage widths break here because the slider itself is the flex parent
     and CSS can't resolve self-referential percentages. Use px instead.      */
  function applyWidths() {
    const w = containerEl.offsetWidth;
    sliderEl.style.width      = `${n * w}px`;
    sliderEl.querySelectorAll('.slide').forEach(s => {
      s.style.width     = `${w}px`;
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

  /* ── State ── */
  let current = 0;
  let timer   = null;
  const INTERVAL = 5000;

  function goTo(index) {
    current = ((index % n) + n) % n;
    sliderEl.style.transform = `translateX(-${current * slideWidth}px)`;
    if (dotsEl) {
      dotsEl.querySelectorAll('.dot').forEach((d, i) =>
        d.classList.toggle('active', i === current)
      );
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
    if (banner?.action) resolveAction(banner.action);
  });

  /* ── Keyboard: Enter / Space on focused slide ── */
  sliderEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const slide = e.target.closest('.slide');
    if (!slide) return;
    e.preventDefault();
    const banner = banners[parseInt(slide.dataset.bannerIndex, 10)];
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
