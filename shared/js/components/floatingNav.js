/* ════════════════════════════════════════════════════════════════════
   HandyHub · Global Floating Navigation
   shared/js/components/floatingNav.js

   Usage: <script src="../shared/js/components/floatingNav.js"></script>
   Place as the LAST <script> before </body>.

   Nav layout
   ───────────────────────────────────────────────────────────────
   dashboard.html  →  Home | Bookings | [⚡ Emergency] | Saved | Profile
   every other page →  Home | Bookings | [🔔 Alerts]   | Saved | Profile

   The emergency centre item is a flat, same-height nav button — no
   elevation, no floating, no absolute positioning. It just has a
   distinctive red circle icon to stand out inline.
════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── 0. Capture currentScript immediately ─────────────────── */
  var _scriptEl = document.currentScript;

  /* ── 1. Inject CSS ────────────────────────────────────────── */
  function injectCSS() {
    if (document.querySelector('link[href*="floatingNav.css"]')) return;
    var href = '../shared/css/floatingNav.css';
    if (_scriptEl && _scriptEl.src) {
      href = _scriptEl.src.replace(
        /\/js\/components\/floatingNav\.js(\?.*)?$/, '/css/floatingNav.css'
      );
    }
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }

  /* ── 2. Page & active-tab detection ──────────────────────── */
  var PAGE = (location.pathname.split('/').pop() || '').toLowerCase();
  var IS_DASHBOARD = (PAGE === 'dashboard.html' || PAGE === 'index.html' || PAGE === '');

  var ROUTE_MAP = {
    'dashboard.html'    : 'home',
    'index.html'        : 'home',
    ''                  : 'home',
    'booking.html'      : 'bookings',
    'notification.html' : 'alerts',
    'saved.html'        : 'saved',
    'profile.html'      : 'profile',
  };
  var activeTab = ROUTE_MAP[PAGE] || null;

  /* ── 3. SVG icons (currentColor so CSS drives colour) ──────── */
  var IC = {
    home:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<polyline points="9 22 9 12 15 12 15 22"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',

    bookings:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.85"/>' +
      '<path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>' +
      '<path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"' +
      ' stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
      '</svg>',

    alerts:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M13.73 21a2 2 0 0 1-3.46 0"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>' +
      '</svg>',

    saved:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',

    profile:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.85"/>' +
      '</svg>',

    em:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M13 2.5 4.5 14H11l-1 7.5L19.5 10H13Z"' +
      ' stroke="currentColor" stroke-width="1.85" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>',
  };

  /* ── 4. Helper: regular link nav item ─────────────────────── */
  function mkItem(tab, label, href, badgeId) {
    var cls = 'hh-fnav-item' + (tab === activeTab ? ' hh-fnav-active' : '');
    var badge = badgeId
      ? '<span class="hh-fnav-badge" id="' + badgeId + '" style="display:none;"></span>'
      : '';
    return (
      '<a href="' + href + '" class="' + cls + '" data-tab="' + tab + '" aria-label="' + label + '" style="position:relative;">' +
        '<span class="hh-fnav-icon">' + IC[tab] + '</span>' +
        badge +
        '<span class="hh-fnav-label">' + label + '</span>' +
      '</a>'
    );
  }

  /* ── 5. Emergency centre item (dashboard only, flat/inline) ── */
  var EM_ITEM =
    '<button class="hh-fnav-item hh-fnav-em-item" id="hh-em-fab"' +
    ' aria-label="Emergency – get help now" data-tab="em">' +
      '<span class="hh-fnav-em-circle">' + IC.em + '</span>' +
      '<span class="hh-fnav-label hh-fnav-em-label">SOS</span>' +
    '</button>';

  /* ── 6. Alerts centre item (every other page, with unread badge) */
  var ALERTS_ITEM = mkItem('alerts', 'Alerts', 'notification.html', 'hh-fnav-alerts-badge');

  /* ── 7. Build full nav HTML ───────────────────────────────── */
  var CENTRE = IS_DASHBOARD ? EM_ITEM : ALERTS_ITEM;

  var NAV_HTML =
    '<nav id="hh-floating-nav" class="hh-fnav" aria-label="Main navigation">' +
      '<div class="hh-fnav-pill">' +
        mkItem('home',     'Home',     'dashboard.html') +
        mkItem('bookings', 'Bookings', 'booking.html')   +
        CENTRE                                           +
        mkItem('saved',    'Saved',    'saved.html')     +
        mkItem('profile',  'Profile',  'profile.html')   +
      '</div>' +
    '</nav>';

  /* ── 8. Emergency modal types ─────────────────────────────── */
  var EM_TYPES = [
    { id:'plumbing',   name:'Plumbing',    service:'Plumbing',
      icon:'<path d="M12 22s-8-6-8-13a8 8 0 0 1 16 0c0 7-8 13-8 13z" stroke="currentColor" stroke-width="2"/><path d="M8 10h8M12 6v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    { id:'electrical', name:'Electrical',  service:'Electrical',
      icon:'<path d="M13 10V3L4 14h7v7l9-11h-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
    { id:'ac_repair',  name:'AC Repair',   service:'AC Repair',
      icon:'<rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M12 6v12M8 10h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    { id:'carpentry',  name:'Carpentry',   service:'Carpentry',
      icon:'<path d="M14.5 2.5c0 1.5-1.5 3-1.5 3H8L5.5 9l3 3-3 4.5 2 1 3-4.5h3.5l5 5 1.5-1.5-5-5V8.5s1.5-1.5 1.5-3a2 2 0 0 0-2-3z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    { id:'appliance',  name:'Appliance',   service:'Appliance Repair',
      icon:'<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 12h6M9 15h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    { id:'locksmith',  name:'Locksmith',   service:'Locksmith',
      icon:'<rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="currentColor"/>' },
    { id:'water_leak', name:'Water Leak',  service:'Plumbing',
      icon:'<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
    { id:'power_out',  name:'Power Out',   service:'Electrical',
      icon:'<path d="M13 2L4.5 13.5H11L10 22L19.5 10H13Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
    { id:'cleaning',   name:'Cleaning',    service:'Cleaning',
      icon:'<path d="M3 3l18 18M9 9c-1.5 1.5-2 3-2 5a5 5 0 0 0 10 0c0-5-4-7-4-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
    { id:'other',      name:'Other',       service:'General Emergency',
      icon:'<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  ];

  var EM_MODAL_HTML =
    '<div id="em-type-modal" class="em-modal-overlay">' +
      '<div class="em-modal-sheet" id="hh-em-sheet">' +
        '<div class="em-modal-handle"></div>' +
        '<div class="em-modal-header">' +
          '<div class="em-modal-header-icon">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none">' +
            '<path d="M13 10V3L4 14h7v7l9-11h-7z" stroke="#fff"' +
            ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg></div>' +
          '<div>' +
            '<h3 class="em-modal-title">What\'s the emergency?</h3>' +
            '<p class="em-modal-sub">We\'ll find the nearest available professional</p>' +
          '</div>' +
        '</div>' +
        '<div class="em-type-grid" id="em-type-grid"></div>' +
        '<button class="em-modal-cancel" id="hh-em-cancel">Cancel</button>' +
      '</div>' +
    '</div>';

  /* ── 9. Open / close ─────────────────────────────────────── */
  function openEM() {
    var el = document.getElementById('em-type-modal');
    if (el) { el.classList.add('em-modal-visible'); document.body.style.overflow = 'hidden'; }
  }
  function closeEM() {
    var el = document.getElementById('em-type-modal');
    if (el) { el.classList.remove('em-modal-visible'); document.body.style.overflow = ''; }
  }

  /* Keep global names for any existing onclick= attributes */
  window.openEmergencyModal        = openEM;
  window.closeEmergencyModal       = closeEM;
  window.handleEmModalOverlayClick = function (e) {
    if (e.target === document.getElementById('em-type-modal')) closeEM();
  };
  window.selectEmergencyType = function (id, svc) {
    sessionStorage.setItem('hh_service', svc);
    sessionStorage.setItem('hh_task',   'Emergency – ' + svc);
    sessionStorage.setItem('em_service', svc);
    closeEM();
    setTimeout(function () { window.location.href = 'book-emergency.html'; }, 220);
  };

  /* ── 10. Swipe-to-dismiss ────────────────────────────────── */
  function wireSwipe() {
    var sheet = document.getElementById('hh-em-sheet');
    var ov    = document.getElementById('em-type-modal');
    if (!sheet || !ov) return;
    var sy = 0, dy = 0, on = false;
    sheet.addEventListener('touchstart', function (e) {
      sy = e.touches[0].clientY; dy = 0; on = true; sheet.style.transition = 'none';
    }, { passive: true });
    sheet.addEventListener('touchmove', function (e) {
      if (!on) return;
      dy = e.touches[0].clientY - sy; if (dy < 0) return;
      sheet.style.transform = 'translateY(' + dy + 'px)';
      ov.style.background = 'rgba(0,0,0,' + (0.52 * (1 - Math.min(dy / (sheet.offsetHeight * 0.5), 1))) + ')';
    }, { passive: true });
    sheet.addEventListener('touchend', function () {
      if (!on) return; on = false;
      if (dy > sheet.offsetHeight * 0.35) {
        sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
        sheet.style.transform  = 'translateY(110%)';
        ov.style.transition = 'background 0.3s'; ov.style.background = 'rgba(0,0,0,0)';
        setTimeout(function () { closeEM(); sheet.style.cssText = ''; ov.style.cssText = ''; }, 300);
      } else {
        sheet.style.transition = 'transform 0.4s cubic-bezier(0.34,1.56,0.64,1)';
        sheet.style.transform  = 'translateY(0)';
        setTimeout(function () { sheet.style.cssText = ''; }, 420);
      }
    });
  }

  /* ── 11. Init ────────────────────────────────────────────── */
  function init() {
    if (document.getElementById('hh-floating-nav')) return;

    document.body.insertAdjacentHTML('beforeend', NAV_HTML);

    if (!document.getElementById('em-type-modal')) {
      document.body.insertAdjacentHTML('beforeend', EM_MODAL_HTML);
    }

    var grid = document.getElementById('em-type-grid');
    if (grid && grid.children.length === 0) {
      grid.innerHTML = EM_TYPES.map(function (t) {
        return (
          '<button class="em-type-btn" onclick="selectEmergencyType(\'' + t.id + '\',\'' + t.service + '\')">' +
            '<div class="em-type-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none">' + t.icon + '</svg></div>' +
            '<span class="em-type-name">' + t.name + '</span>' +
          '</button>'
        );
      }).join('');
    }

    /* Wire emergency button (dashboard only — safe no-op on other pages) */
    var fab = document.getElementById('hh-em-fab');
    if (fab) fab.addEventListener('click', openEM);

    var cancel = document.getElementById('hh-em-cancel');
    if (cancel) cancel.addEventListener('click', closeEM);

    var ov = document.getElementById('em-type-modal');
    if (ov) ov.addEventListener('click', function (e) { if (e.target === ov) closeEM(); });

    wireSwipe();
    document.body.classList.add('hh-has-fnav');

    /* Paint notification badge from localStorage (instant) */
    refreshAlertBadge();

    /* Then upgrade to a realtime Firestore subscription */
    startRealtimeBadge();
  }

  /* ── 12. Notification badge ──────────────────────────────── */
  function refreshAlertBadge() {
    var badgeEl = document.getElementById('hh-fnav-alerts-badge');
    if (!badgeEl) return; // only on non-dashboard pages
    var count = 0;
    try { count = parseInt(localStorage.getItem('unread_notifications') || '0', 10); } catch {}
    if (count > 0) {
      badgeEl.textContent = count > 99 ? '99+' : String(count);
      badgeEl.style.display = 'flex';
    } else {
      badgeEl.style.display = 'none';
    }
  }
  /* Keep a global so notificationPage can call it after marking read */
  window.hhRefreshAlertBadge = refreshAlertBadge;

  /* ── 13. Realtime unread-count subscription ───────────────── */
  var _unreadUnsub = null;

  function startRealtimeBadge() {
    if (IS_DASHBOARD) return;            // dashboard shows SOS, not alerts badge
    if (_unreadUnsub)  return;           // already subscribed
    if (!_scriptEl || !_scriptEl.src) return; // can't resolve module path

    // Derive the root of the shared/ directory from this script's URL
    // e.g. "https://host/shared/js/components/floatingNav.js" → "https://host/shared"
    var sharedRoot = _scriptEl.src.replace(/\/js\/components\/floatingNav\.js.*$/, '');

    Promise.resolve()
      .then(function () { return import(sharedRoot + '/js/app/container.js'); })
      .then(function (mod) {
        var container = mod.getAppContainer();
        return container.services.authService.waitForUser();
      })
      .then(function (user) {
        if (!user) return;
        return import(sharedRoot + '/js/services/notificationRepository.js')
          .then(function (repo) {
            _unreadUnsub = repo.subscribeToUnreadCount(user.uid, function (count) {
              try { localStorage.setItem('unread_notifications', String(count)); } catch (_) {}
              refreshAlertBadge();
            });
          });
      })
      .catch(function (err) {
        // Non-fatal: badge falls back to stale localStorage value
        console.warn('[floatingNav] Realtime badge unavailable, using localStorage:', err.message);
      });
  }

  window.addEventListener('pagehide', function () {
    if (_unreadUnsub) { _unreadUnsub(); _unreadUnsub = null; }
  });

  /* ── Run ─────────────────────────────────────────────────── */
  injectCSS();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
