// --- GLOBAL CENTRALIZED APPLICATION CONTROLLER ---
(() => {
  // Prevent duplicate execution if the script is imported multiple times
  if (window.__globalAppInitialized__) {
    return;
  }
  window.__globalAppInitialized__ = true;

  // 1. Inject the viewport scale constraints programmatically into the active HTML head
  function lockViewportConfiguration() {
    let metaViewport = document.querySelector('meta[name="viewport"]');
    const secureScaleConfig = "width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no";
    
    if (!metaViewport) {
      metaViewport = document.createElement('meta');
      metaViewport.name = 'viewport';
      document.head.appendChild(metaViewport);
    }
    metaViewport.setAttribute('content', secureScaleConfig);
  }

  // 2. Inject global accessibility style rules across all text field elements universally
  function injectGlobalInputCSS() {
    if (document.getElementById('global-app-input-style')) {
      return;
    }

    const styleNode = document.createElement('style');
    styleNode.id = 'global-app-input-style';
    styleNode.textContent = `
      /* Universal lock forcing 16px to completely kill native OS zoom events */
      input[type="text"], input[type="search"], input[type="tel"], input[type="email"], 
      input[type="number"], input[type="password"], input[type="url"], input[type="datetime-local"], 
      input[type="date"], input[type="time"], input[type="month"], input[type="week"], textarea, select {
        font-size: 16px !important;
      }
      /* Prevent containers from creating horizontal scroll shifts */
      html, body {
        width: 100% !important;
        overflow-x: hidden !important;
        position: relative !important;
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
  lockViewportConfiguration();
  injectGlobalInputCSS();
  setupNavigationFocusGuard();
})();
