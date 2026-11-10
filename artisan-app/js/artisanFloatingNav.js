/* ════════════════════════════════════════════════════════════════════
   Fidus X Artisan · the liveness heartbeat, on every signed-in screen
   artisan-app/js/artisanFloatingNav.js

   Usage: <script src="js/artisanFloatingNav.js"></script>
   Place as the LAST <script> before </body>.

   On every artisan page this follows the live profile and calls
   presenceService.ensurePresence, so moving between screens — or staying on
   one, such as a job — never drops an available artisan out of dispatch
   (functions/artisanIndex.js counts an artisan as reachable for 15 minutes
   after the last heartbeat). It never writes availability: going online and
   stopping offers happen on Today, where the state they change is shown.

   It draws nothing. Until Phase 5 it also drew the four tabs on screens not
   yet on the design system (hence the file name, kept so no page's script
   tag changes); every screen now draws its own with js/fx/controls.js
   renderTabbar, and names its own tab there.
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

  /* ── Liveness heartbeat on every page ────────────────────────────── */
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

  /* ── Init ────────────────────────────────────────────────────────── */
  function init() {
    if (window.__fxHeartbeat) return;      // the script was included twice
    window.__fxHeartbeat = true;
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
