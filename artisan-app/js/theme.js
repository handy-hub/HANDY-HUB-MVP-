/* ============================================================================
   Fidus X Artisan · theme bootstrap
   ----------------------------------------------------------------------------
   A classic script, loaded synchronously in <head> BEFORE the stylesheets, so
   the theme is decided before the first pixel is painted. Every artisan page
   is a full document load (the app is multi-page), so this runs on each one.

   It decides one thing: whether <html> carries data-theme="dark". The colours
   themselves live in css/tokens.css (:root[data-theme="dark"]); nothing here
   or in any component knows a colour.

   The preference is the device's, kept in localStorage under `pref_theme`
   (the key the app has always used, so an earlier choice is honoured):
       'Light'   (the default when nothing is stored)
       'Dark'
       'System'  follow the device's light/dark setting, live
   A browser that blocks storage gets the light theme and no error.
   ========================================================================== */
(function () {
  'use strict';
  var KEY = 'pref_theme';
  var root = document.documentElement;
  var media = null;
  try { media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null; } catch (e) { media = null; }

  var memory = null;   // the choice when storage is blocked: it lasts for this page

  function read() {
    if (memory) return memory;
    try {
      var v = window.localStorage.getItem(KEY);
      return v === 'Dark' || v === 'System' ? v : 'Light';
    } catch (e) { return 'Light'; }
  }
  function isDark(pref) { return pref === 'Dark' || (pref === 'System' && !!media && media.matches); }

  function paint() {
    var dark = isDark(read());
    if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    root.classList.toggle('dark', dark);
    // The page canvas and its scrollbars follow the root's colour scheme, and
    // do so before any stylesheet has arrived.
    root.style.colorScheme = dark ? 'dark' : 'light';
    return dark;
  }

  function set(value) {
    var v = value === 'Dark' || value === 'System' ? value : 'Light';
    try { window.localStorage.setItem(KEY, v); memory = null; } catch (e) { memory = v; }
    paint();
    return v;
  }

  paint();

  // 'System': follow the device as it changes (sunset schedules, a quick toggle).
  if (media) {
    var onDevice = function () { if (read() === 'System') paint(); };
    if (media.addEventListener) media.addEventListener('change', onDevice);
    else if (media.addListener) media.addListener(onDevice);
  }
  // A page restored from the back/forward cache kept the theme it had when it
  // was left; the preference may have changed in Account since.
  window.addEventListener('pageshow', function (e) { if (e.persisted) paint(); });
  // The preference changed in another tab or window of the app.
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) paint(); });

  window.fxTheme = { get: read, set: set, isDark: function () { return isDark(read()); } };
})();
