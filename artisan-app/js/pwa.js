/**
 * pwa.js — registers the artisan app-shell worker (artisan-app/sw.js, AR-16).
 *
 * Scope /artisan-app/, separate from the push worker at '/' (see sw.js). Only
 * on HTTPS or localhost, where browsers allow service workers. A failure is
 * logged and ignored: the app works without the worker, just not offline.
 */
(function () {
  if (!('serviceWorker' in navigator)) return;
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/artisan-app/sw.js', { scope: '/artisan-app/' })
      .catch(function (err) { console.warn('[pwa] App-shell worker not registered:', err && err.message); });
  });
})();
