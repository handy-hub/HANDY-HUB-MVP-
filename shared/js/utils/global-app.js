// --- GLOBAL CENTRALIZED APPLICATION CONTROLLER ---
(() => {
  // Prevent duplicate execution if the script is imported multiple times
  if (window.__globalAppInitialized__) {
    return;
  }
  window.__globalAppInitialized__ = true;

  // 1. Keep viewport predictable while preserving zoom accessibility.
  function ensureViewportConfiguration() {
    let metaViewport = document.querySelector('meta[name="viewport"]');

    // interactive-widget=resizes-visual  →  Android Chrome: keyboard shrinks only
    // the VISUAL viewport, not the layout viewport, so the page never reflows
    // when the on-screen keyboard appears.
    // viewport-fit=cover                →  iPhone notch / safe-area support.
    const preferredViewport =
      "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-visual";

    if (!metaViewport) {
      metaViewport = document.createElement('meta');
      metaViewport.name = 'viewport';
      document.head.appendChild(metaViewport);
    }

    metaViewport.setAttribute('content', preferredViewport);
  }

  // 2. Add lightweight global layout safety rules.
  function injectGlobalLayoutCSS() {
    if (document.getElementById('global-app-layout-style')) {
      return;
    }

    const styleNode = document.createElement('style');
    styleNode.id = 'global-app-layout-style';
    styleNode.textContent = `
      html, body {
        width: 100% !important;
        max-width: 100% !important;
        overflow-x: hidden !important;
      }
      img, svg, video, canvas {
        max-width: 100%;
        height: auto;
      }

      /*
       * iOS Safari zooms into any input whose font-size is < 16px.
       * Forcing a minimum of 16px stops the zoom without disabling
       * user pinch-zoom (accessibility-safe).
       * !important ensures page-specific CSS cannot override this.
       */
      input, input[type], textarea, select {
        font-size: max(16px, 1em) !important;
      }
    `;
    document.head.appendChild(styleNode);
  }

  // 3. Automated focus cleaning when switching or backgrounding pages
  function setupNavigationFocusGuard() {
    const clearActiveFocusState = () => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    };

    // `pagehide` ONLY — deliberately not `beforeunload`.
    //
    // Registering a beforeunload listener makes the page ineligible for the
    // back/forward cache in Firefox and in many Chrome versions. global-app.js
    // is imported by effectively every screen, so this one line was opting the
    // entire application out of bfcache — which is why pressing back rebuilt
    // the whole document instead of restoring it.
    //
    // pagehide fires in every case beforeunload did, plus when the page enters
    // bfcache, so nothing is lost. Blurring the focused element is cosmetic
    // cleanup; it was never worth the cost of a full reload on every back.
    window.addEventListener('pagehide', clearActiveFocusState);
  }

  // Boot dependencies immediately on script connection evaluation
  ensureViewportConfiguration();
  injectGlobalLayoutCSS();
  setupNavigationFocusGuard();
})();
