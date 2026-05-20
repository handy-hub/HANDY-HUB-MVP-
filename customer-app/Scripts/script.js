// --- SEARCH UI, DYNAMIC CONTENT & TRACKING INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('tracking-search-input');
  const tagCloud = document.querySelector('.tag-cloud');
  
  // Local array caching database entries up to 8 max items
  let cachedServices = [];
  let isExpanded = false;

  // 1. Instantly focus the input for rapid desktop and mobile typing
  if (searchInput) {
    searchInput.focus();
  }

  // 2. Mapping table correlating database lookup strings to your assets
  const logoMap = {
    'electricals': '../shared/assets/icons/electricals.png',
    'plumbing': '../shared/assets/icons/plummer.png',
    'cooling': '../shared/assets/icons/cooling.png',
    'painter': '../shared/assets/icons/painter.png',
    'carpenter': '../shared/assets/icons/carpenter.png',
    'welder': '../shared/assets/icons/welder.png'
  };

  // 3. UI Redraw Engine
  function renderTags() {
    if (!tagCloud) return;

    // Toggle rules: slice array down to 5 initial tags or pull all 8 tags
    const limit = isExpanded ? 8 : 5;
    const itemsToRender = cachedServices.slice(0, limit);

    let tagsHTML = '';
    itemsToRender.forEach(item => {
      const logoSrc = logoMap[item.type?.toLowerCase()] || '../shared/assets/icons/more.png';
      tagsHTML += `
        <button type="button" class="search-tag" data-search="${item.name}">
          <img src="${logoSrc}" alt="">
          <p> ${item.name}</p>
        </button>
      `;
    });

    // Provide expansion button if database yields more items than standard display cap
    if (cachedServices.length > 5) {
      const toggleText = isExpanded ? 'See less' : 'See more';
      tagsHTML += `
        <button type="button" class="search-tag toggle-expand" data-search="${toggleText}">
          <p> ${toggleText}</p>
        </button>
      `;
    }

    tagCloud.innerHTML = tagsHTML;
  }

  // 4. Fetch dynamic payload array from server database endpoint
  async function loadPopularServices() {
    try {
      const response = await fetch('/api/popular-searches'); 
      const data = await response.json(); 
      
      if (!Array.isArray(data) || data.length === 0) return;
      
      // Cache server results up to strict maximum display ceiling
      cachedServices = data.slice(0, 8);
      renderTags();
    } catch (error) {
      console.error('Failed to load popular services from DB:', error);
      // Fallback state: harvest static tags pre-built into HTML template if database fails
      harvestStaticFallback();
    }
  }

  // Parses hardcoded elements in case API fails or goes offline
  function harvestStaticFallback() {
    const staticTags = tagCloud.querySelectorAll('.search-tag:not(.toggle-expand)');
    cachedServices = Array.from(staticTags).map(btn => ({
      name: btn.getAttribute('data-search') || btn.textContent.trim(),
      type: btn.querySelector('img')?.src.split('/').pop().split('.')[0] || 'more'
    }));
  }

  // Start initialization lifecycle
  loadPopularServices();

  // 5. Unified Event Delegation Controller (DOUBLE-GUARDED)
  if (tagCloud) {
    tagCloud.addEventListener('click', (event) => {
      const clickedTag = event.target.closest('.search-tag');
      if (!clickedTag) return;

      const queryValue = clickedTag.getAttribute('data-search') || '';

      // Intercept layout expansion if the button has the class OR if the text matches the toggle text
      if (clickedTag.classList.contains('toggle-expand') || queryValue === 'See more' || queryValue === 'See less') {
        isExpanded = !isExpanded; 
        renderTags(); 
        if (searchInput) searchInput.focus();
        return; // HALT HERE: Stops it from running the input injection below
      }
      
      // Handle standard queries (Only injects actual keywords)
      if (queryValue && searchInput) {
        searchInput.value = queryValue;
        searchInput.focus();
        
        // Optional: Run execution method directly upon tag click
        // executeSearch(queryValue);
      }
    });
  }

  // 6. Global safety-critical logic loading
  function injectScript(src, onError) {
    const script = document.createElement("script");
    script.src = src;
    script.defer = true;
    if (typeof onError === "function") {
      script.onerror = onError;
    }
    document.head.appendChild(script);
  }

  injectScript("js/pages/trackingPage.js", () => {
    console.warn("trackingPage.js failed to load.");
  });
});
