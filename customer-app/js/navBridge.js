/* ============================================================================
 * navBridge.js — hardware/system back, and protection against double taps.
 *
 * This does NOT introduce a second navigation system. Every decision is
 * delegated to window.HH_Nav (js/navContext.js), which owns the resolution
 * order: ?from= -> validated history -> journey stack -> declared fallback.
 * This file only supplies the two INPUTS that contract has no way to hear:
 *
 *   1. Android's hardware/gesture Back inside Capacitor.
 *   2. A second tap landing before the first navigation has committed.
 *
 * WHY ANDROID BACK NEEDS THIS
 * ───────────────────────────
 * In a Capacitor WebView the hardware Back button does NOT map to browser
 * history by default. Left alone it closes the whole app from any screen —
 * a customer pressing Back on the bookings list would be ejected mid-journey.
 * Capacitor exposes it as an App plugin event, so it is forwarded to the same
 * HH_Nav.back() the on-screen arrow uses. One behaviour, three entry points:
 * arrow, browser Back, hardware Back.
 *
 * The plugin is absent in a normal browser, so the import is dynamic and its
 * failure is expected and silent — the browser's own Back already works.
 *
 * WHY DOUBLE TAPS MATTER
 * ──────────────────────
 * Full document loads on a slow connection leave the old page interactive for
 * a second or more. Tapping twice pushes two history entries for one intent,
 * so Back appears to do nothing the first time. Disabling the button in JS is
 * not enough — the guard has to cover every navigation path.
 * ========================================================================= */

(function () {
  'use strict';

  // ── 1. One navigation per gesture ────────────────────────────────────────
  var navigating = false;

  // A real navigation is committing; ignore anything that follows.
  window.addEventListener('pagehide', function () { navigating = true; });
  // Restored from bfcache (or a cancelled navigation): become interactive again.
  window.addEventListener('pageshow', function (e) { if (e.persisted) navigating = false; });

  function claim() {
    if (navigating) return false;
    navigating = true;
    // If nothing actually navigated (blocked, same URL, handler threw), release
    // the latch rather than leaving the screen permanently unresponsive.
    setTimeout(function () { navigating = false; }, 1200);
    return true;
  }

  // Swallow the SECOND tap on any in-app link or nav control, capture-phase so
  // it runs before the page's own handlers.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest
      ? e.target.closest('a[href], [data-tab], .back-btn, [onclick*="location.href"]')
      : null;
    if (!t) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;   // let the browser handle it

    var href = t.getAttribute && t.getAttribute('href');
    if (href && (href.charAt(0) === '#' || /^(mailto|tel|https?):/i.test(href))) return;

    if (!claim()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ── 2. Android hardware / system back ────────────────────────────────────
  function wireHardwareBack() {
    if (!window.Capacitor) return;              // plain browser: nothing to do
    import('@capacitor/app')
      .then(function (mod) {
        var App = mod && (mod.App || mod.default);
        if (!App || !App.addListener) return;
        App.addListener('backButton', function (info) {
          // canGoBack comes from the WebView's own history depth.
          if (info && info.canGoBack === false && window.HH_Nav) {
            // Nothing behind us in this WebView — let HH_Nav decide whether a
            // declared fallback exists rather than dropping the customer out
            // of the app.
            window.HH_Nav.back();
            return;
          }
          if (window.HH_Nav) window.HH_Nav.back();
          else window.history.back();
        });
      })
      .catch(function () { /* plugin not installed yet — browser Back still works */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireHardwareBack);
  } else {
    wireHardwareBack();
  }
})();
