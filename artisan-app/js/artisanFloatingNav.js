/* ════════════════════════════════════════════════════════════════════
   Fidus X Artisan · the four tabs, on screens not yet on the design system
   artisan-app/js/artisanFloatingNav.js

   Usage: <script src="js/artisanFloatingNav.js"></script>
   Place as the LAST <script> before </body>.

   Phase 2 (design decision 02): every artisan screen shows the same four tabs
     Today | Jobs | Earnings | Account
   drawn by the design system's own tab bar (js/fx/controls.js renderTabbar).
   Screens already on the system (body.fx-app with their own nav.fx-tabbar —
   Today) draw it themselves; this script draws it on the rest, fixed to the
   bottom, until each screen moves.

   Availability is no longer a nav control: going online and stopping offers
   happen on Today, where the state they change is shown. What this script
   keeps is the liveness heartbeat: on every artisan page it follows the live
   profile and calls presenceService.ensurePresence, so moving between screens
   never drops an available artisan out of dispatch. It never writes
   availability.
════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var _scriptEl = document.currentScript;

  function root(sub) {
    if (_scriptEl && _scriptEl.src) {
      return _scriptEl.src.replace(/\/artisan-app\/js\/artisanFloatingNav\.js.*$/, sub);
    }
    return '..' + sub;
  }

  /* ── 1. Which tab this page belongs to ──────────────────────────── */
  var PAGE = (location.pathname.split('/').pop() || '').toLowerCase();
  var ROUTE_MAP = {
    'dashboard.html'    : 'today',
    'index.html'        : 'today',
    ''                  : 'today',
    // Opened from Today's header bell.
    'notifications.html': 'today',
    'jobs.html'         : 'jobs',
    'bookings.html'     : 'jobs',      // retired -> redirects to jobs.html
    'job.html'          : 'jobs',      // single-booking screen
    'messages.html'     : 'jobs',      // conversations belong to job work
    'wallet.html'       : 'earnings',
    'settings.html'     : 'account',
    'profile.html'      : 'account',
    'performance.html'  : 'account',
    'reviews.html'      : 'account',
    'support.html'      : 'account',
  };
  var activeTab = ROUTE_MAP[PAGE] || null;

  /* ── 2. The tab bar ──────────────────────────────────────────────── */
  function injectCSS() {
    // The system's tokens and components; every selector in them is scoped to
    // an .fx- class, so they style nothing else on a legacy page. legacy-shell.css
    // fixes the bar to the bottom and leaves room for it.
    ['/artisan-app/css/tokens.css', '/artisan-app/css/app.css', '/artisan-app/css/fx/legacy-shell.css'].forEach(function (p) {
      if (document.querySelector('link[href$="' + p.split('/').slice(-2).join('/') + '"]')) return;
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = root(p);
      document.head.appendChild(l);
    });
  }

  function drawTabs() {
    if (document.querySelector('nav.fx-tabbar')) return;     // the screen draws its own
    var host = document.createElement('div');
    host.className = 'fx-bottom fx-bottom--fixed';
    host.innerHTML = '<nav class="fx-tabbar" aria-label="Main" id="fx-tabbar"></nav>';
    document.body.appendChild(host);
    document.body.classList.add('fx-has-tabbar');
    import(root('/artisan-app/js/fx/controls.js'))
      .then(function (m) { m.renderTabbar(document.getElementById('fx-tabbar'), { current: activeTab }); })
      .catch(function (err) { console.warn('[artisanNav] tab bar:', err && err.message); });
  }

  /* ── 3. Liveness heartbeat on every page ─────────────────────────── */
  var _unsub = null;
  function stopPresenceFollow() {
    if (_unsub) { try { _unsub(); } catch (_) {} }
    _unsub = null;
  }
  function followPresence() {
    stopPresenceFollow();   // never two listeners, however often this runs
    import(root('/shared/js/app/container.js'))
      .then(function (mod) {
        var c = mod.getAppContainer();
        return c.services.authService.waitForUser().then(function (user) {
          if (!user) return;
          stopPresenceFollow();
          _unsub = c.services.databaseService.subscribeToDocument('artisans', user.uid, function (snap) {
            if (!snap || !snap.exists) return;
            // Liveness heartbeat on every artisan page, not only Today/Jobs
            // (functions/artisanIndex.js ranks a recently-seen artisan higher).
            // From a live answer only; it never writes availability.
            if (!snap.fromCache) {
              var approved = String(snap.data.verificationStatus || '').toLowerCase() === 'approved';
              import(root('/shared/js/services/presenceService.js'))
                .then(function (p) { p.ensurePresence(user.uid, c.services.databaseService, approved && snap.data.isAvailable === true); })
                .catch(function () {});
            }
          }, function (err) {
            console.warn('[artisanNav] presence listener:', err && err.message);
          });
        });
      })
      .catch(function () {});
  }

  /* ── 4. Init ─────────────────────────────────────────────────────── */
  function init() {
    if (document.getElementById('fx-tabbar')) return;
    injectCSS();
    drawTabs();
    followPresence();
    // Leaving the page drops the listener; a page restored from the browser's
    // back/forward cache does not re-run this script, so it subscribes again.
    window.addEventListener('pagehide', stopPresenceFollow);
    window.addEventListener('pageshow', function (e) { if (e.persisted) followPresence(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
