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
    const preferredViewport = "width=device-width, initial-scale=1.0, viewport-fit=cover";
    
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

    window.addEventListener('pagehide', clearActiveFocusState);
    window.addEventListener('beforeunload', clearActiveFocusState);
  }

  // Boot dependencies immediately on script connection evaluation
  ensureViewportConfiguration();
  injectGlobalLayoutCSS();
  setupNavigationFocusGuard();
})();
