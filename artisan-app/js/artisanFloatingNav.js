/* ════════════════════════════════════════════════════════════════════
   HandyHub Artisan · Floating Navigation
   artisan-app/js/artisanFloatingNav.js

   Usage: <script src="js/artisanFloatingNav.js"></script>
   Place as the LAST <script> before </body>.

   This is the artisan sibling of the Customer App's shared floatingNav.js.
   It reuses the EXACT same glass-pill markup, structure, sizing, motion,
   active glow and badge system (shared/css/floatingNav.css) so both apps
   read as one product family. The only differences are role-specific:
     • routes + labels  →  artisan workflow
     • accent colour    →  artisan orange (via the .hh-fnav--artisan scope)
     • centre item      →  a "Go Online" availability toggle (the artisan's
                           most frequent action), in place of the customer's
                           SOS/Emergency button.

   Nav layout (every page):
     Home | Jobs | [ Go Online ] | Bookings | Profile
════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var _scriptEl = document.currentScript;

  /* ── 1. Inject the SHARED nav CSS (single source of truth) + orange skin ── */
  function injectCSS() {
    // Reuse the customer/shared glass-pill stylesheet verbatim.
    if (!document.querySelector('link[href*="floatingNav.css"]')) {
      var href = '../shared/css/floatingNav.css';
      if (_scriptEl && _scriptEl.src) {
        href = _scriptEl.src.replace(/\/artisan-app\/js\/artisanFloatingNav\.js(\?.*)?$/,
                                     '/shared/css/floatingNav.css');
      }
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      document.head.appendChild(l);
    }
    // Go-Online toggle dot — artisan-only UI element not present in the shared nav CSS.
    // Brand colours come from --nav-brand* tokens declared in design-system.css; no
    // hardcoded hex overrides here.
    if (!document.getElementById('hh-fnav-artisan-skin')) {
      var s = document.createElement('style');
      s.id = 'hh-fnav-artisan-skin';
      s.textContent = [
        '.hh-fnav-online .hh-fnav-online-dot{position:absolute;top:1px;right:calc(50% - 16px);',
        '  width:9px;height:9px;border-radius:50%;background:#9CA3AF;border:2px solid rgba(255,255,255,0.95);',
        '  transition:background .25s ease;}',
        '.hh-fnav-online.is-online .hh-fnav-online-dot{background:#22C55E;}',
        '.hh-fnav-online.is-online{color:var(--nav-brand);}',
        '.hh-fnav-online.is-online .hh-fnav-icon{transform:scale(1.10) translateY(-1px);}',
        '@media (prefers-color-scheme: dark){',
        '  .hh-fnav-online .hh-fnav-online-dot{border-color:rgba(18,18,24,0.95);} }'
      ].join('\n');
      document.head.appendChild(s);
    }
  }

  /* ── 2. Page & active-tab detection ──────────────────────── */
  var PAGE = (location.pathname.split('/').pop() || '').toLowerCase();

  var ROUTE_MAP = {
    'dashboard.html'    : 'home',
    'index.html'        : 'home',
    ''                  : 'home',
    'jobs.html'         : 'jobs',
    'wallet.html'       : 'wallet',
    'bookings.html'     : 'bookings',
    'profile.html'      : 'profile',
    'performance.html'  : 'profile',   // secondary screens map to nearest tab
    'reviews.html'      : 'profile',
    'support.html'      : 'profile',
    'settings.html'     : 'profile',
    'notifications.html': 'jobs',
  };
  var activeTab = ROUTE_MAP[PAGE] || null;

  /* ── 3. SVG icons — same stroke language as the customer nav ─ */
  var IC = {
    home:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<polyline points="9 22 9 12 15 12 15 22" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    jobs:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>' +
      '<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.85"/>' +
      '<path d="M3 11h18M12 11v3" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/></svg>',
    wallet:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<rect x="3" y="6" width="18" height="13" rx="2.5" stroke="currentColor" stroke-width="1.85"/>' +
      '<path d="M3 9h13a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H3" stroke="currentColor" stroke-width="1.85"/>' +
      '<circle cx="16.5" cy="12" r="1.1" fill="currentColor"/></svg>',
    bookings:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.85"/>' +
      '<path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>' +
      '<path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    profile:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.85"/></svg>',
    power:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M12 3v9" stroke="currentColor" stroke-width="1.95" stroke-linecap="round"/>' +
      '<path d="M7.4 6.4a7 7 0 1 0 9.2 0" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/></svg>',
  };

  function mkItem(tab, label, href, badgeId) {
    var cls = 'hh-fnav-item' + (tab === activeTab ? ' hh-fnav-active' : '');
    var badge = badgeId
      ? '<span class="hh-fnav-badge" id="' + badgeId + '" style="display:none;"></span>'
      : '';
    return (
      '<a href="' + href + '" class="' + cls + '" data-tab="' + tab + '" aria-label="' + label + '" style="position:relative;">' +
        '<span class="hh-fnav-icon">' + IC[tab] + '</span>' + badge +
        '<span class="hh-fnav-label">' + label + '</span>' +
      '</a>'
    );
  }

  /* ── 4. Centre item: Go Online toggle ─────────────────────── */
  var ONLINE_ITEM =
    '<button class="hh-fnav-item hh-fnav-online" id="hh-online-toggle" data-tab="online" aria-label="Toggle availability" style="position:relative;">' +
      '<span class="hh-fnav-icon">' + IC.power + '</span>' +
      '<span class="hh-fnav-online-dot"></span>' +
      '<span class="hh-fnav-label" id="hh-online-label">Offline</span>' +
    '</button>';

  var NAV_HTML =
    '<nav id="hh-floating-nav" class="hh-fnav hh-fnav--artisan" aria-label="Main navigation">' +
      '<div class="hh-fnav-pill">' +
        mkItem('home',     'Home',     'dashboard.html') +
        mkItem('jobs',     'Jobs',     'jobs.html', 'hh-fnav-jobs-badge') +
        ONLINE_ITEM +
        mkItem('bookings', 'Bookings', 'bookings.html') +
        mkItem('profile',  'Profile',  'profile.html') +
      '</div>' +
    '</nav>';

  /* ── 5. Online toggle behaviour ───────────────────────────── */
  var _toggling = false;

  function paintOnline(isOnline) {
    var btn = document.getElementById('hh-online-toggle');
    var lbl = document.getElementById('hh-online-label');
    if (!btn) return;
    btn.classList.toggle('is-online', !!isOnline);
    if (lbl) lbl.textContent = isOnline ? 'Online' : 'Offline';
    btn.setAttribute('aria-pressed', String(!!isOnline));
  }

  function sharedRoot() {
    if (_scriptEl && _scriptEl.src) {
      return _scriptEl.src.replace(/\/artisan-app\/js\/artisanFloatingNav\.js.*$/, '/shared');
    }
    return '../shared';
  }

  async function toggleOnline() {
    if (_toggling) return;
    _toggling = true;
    try {
      // Development Access Mode: paint the toggle only — never bounce to login
      // and never write to real Firestore under the mock session.
      var dev = await import('../../shared/js/config/devAccess.js').catch(function () { return null; });
      if (dev && dev.isArtisanDevAccessEnabled()) {
        var cur = document.getElementById('hh-online-toggle');
        paintOnline(!(cur && cur.classList.contains('is-online')));
        return;
      }

      var mod = await import(sharedRoot() + '/js/app/container.js');
      var c = mod.getAppContainer();
      var user = await c.services.authService.waitForUser();
      if (!user) { window.location.href = 'login.html'; return; }

      var snap = await c.services.databaseService.getDocument('artisans', user.uid);
      var next = !(snap && snap.data && snap.data.isAvailable);
      // Optimistic paint, then persist (rules permit owner isAvailable update).
      paintOnline(next);
      await c.services.databaseService.updateDocument('artisans', user.uid, {
        isAvailable: next,
        isOnline:    next,
        updatedAt:   new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[artisanNav] online toggle failed:', err.message);
      // Roll the paint back to the real state on failure.
      refreshOnlineState();
    } finally {
      _toggling = false;
    }
  }

  function refreshOnlineState() {
    Promise.resolve()
      .then(function () { return import(sharedRoot() + '/js/app/container.js'); })
      .then(function (mod) {
        var c = mod.getAppContainer();
        return c.services.authService.waitForUser().then(function (user) {
          if (!user) return;
          return c.services.databaseService.getDocument('artisans', user.uid)
            .then(function (snap) { paintOnline(snap && snap.data && snap.data.isAvailable); });
        });
      })
      .catch(function () {});
  }

  /* ── 6. Unread badge on the Jobs tab (new job requests) ───── */
  function refreshJobsBadge() {
    var el = document.getElementById('hh-fnav-jobs-badge');
    if (!el) return;
    var count = 0;
    try { count = parseInt(localStorage.getItem('artisan_unread_alerts') || '0', 10); } catch (_) {}
    if (count > 0) { el.textContent = count > 99 ? '99+' : String(count); el.style.display = 'flex'; }
    else { el.style.display = 'none'; }
  }
  window.hhRefreshArtisanBadge = refreshJobsBadge;

  /* ── 7. Init ──────────────────────────────────────────────── */
  function init() {
    if (document.getElementById('hh-floating-nav')) return;
    document.body.insertAdjacentHTML('beforeend', NAV_HTML);
    document.body.classList.add('hh-has-fnav');

    var toggle = document.getElementById('hh-online-toggle');
    if (toggle) toggle.addEventListener('click', toggleOnline);

    refreshJobsBadge();
    refreshOnlineState();
  }

  injectCSS();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
