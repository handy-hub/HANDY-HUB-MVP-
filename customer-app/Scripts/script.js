// --- POPULAR SERVICES: dynamic tag cloud + expand/collapse ---
// This file owns ONLY the popular-services API fetch and the
// "See more / See less" expand toggle.
// All search history and search execution logic lives in trackingPage.js.

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('tracking-search-input');
  const tagCloud    = document.querySelector('.tag-cloud');

  let cachedServices = [];
  // Restore expand state so returning users don't re-collapse the list every visit
  let isExpanded = (function() {
    try { return sessionStorage.getItem('hh_tags_expanded') === '1'; } catch { return false; }
  }());

  const logoMap = {
    'electricals': '../shared/assets/icons/electricals.png',
    'electrical':  '../shared/assets/icons/electricals.png',
    'plumbing':    '../shared/assets/icons/plummer.png',
    'plummer':     '../shared/assets/icons/plummer.png',
    'cooling':     '../shared/assets/icons/cooling.png',
    'ac repair':   '../shared/assets/icons/cooling.png',
    'painter':     '../shared/assets/icons/painter.png',
    'painting':    '../shared/assets/icons/painter.png',
    'carpenter':   '../shared/assets/icons/carpenter.png',
    'carpentry':   '../shared/assets/icons/carpenter.png',
    'welder':      '../shared/assets/icons/welder.png',
    'welding':     '../shared/assets/icons/welder.png',
    'cleaning':    '../shared/assets/icons/cleaner.svg',
    'cleaner':     '../shared/assets/icons/cleaner.svg',
    'tiling':      '../shared/assets/icons/carpenter.png',
    'gardening':   '../shared/assets/icons/more.png',
  };

  function renderTags() {
    if (!tagCloud) return;
    const limit        = isExpanded ? 8 : 5;
    const itemsToRender = cachedServices.slice(0, limit);
    let html = '';

    itemsToRender.forEach(item => {
      const logoSrc = logoMap[item.type?.toLowerCase()] || '../shared/assets/icons/more.png';
      html += `
        <button type="button" class="search-tag" data-search="${item.name}">
          <img src="${logoSrc}" alt="" loading="lazy" decoding="async" width="20" height="20">
          <p>${item.name}</p>
        </button>`;
    });

    if (cachedServices.length > 5) {
      const label = isExpanded ? 'See less' : 'See more';
      html += `
        <button type="button" class="search-tag toggle-expand" data-search="${label}">
          <p>${label}</p>
        </button>`;
    }

    tagCloud.innerHTML = html;
  }

  function loadPopularServices() {
    // No remote popular-searches API exists in this project.
    // The static tags already in the HTML are the source of truth.
    harvestStaticFallback();
  }

  function harvestStaticFallback() {
    if (!tagCloud) return;
    const staticTags = tagCloud.querySelectorAll('.search-tag:not(.toggle-expand)');
    cachedServices = Array.from(staticTags).map(btn => ({
      name: btn.getAttribute('data-search') || btn.textContent.trim(),
      type: btn.querySelector('img')?.src.split('/').pop().split('.')[0] || 'more',
    }));
  }

  // Handle only the expand/collapse toggle.
  // Non-toggle tag clicks fall through to trackingPage.js's wirePopularTags().
  if (tagCloud) {
    tagCloud.addEventListener('click', e => {
      const tag = e.target.closest('.search-tag');
      if (!tag) return;
      const isToggle =
        tag.classList.contains('toggle-expand') ||
        ['see more', 'see less'].includes((tag.getAttribute('data-search') || '').toLowerCase());

      if (isToggle) {
        isExpanded = !isExpanded;
        try { sessionStorage.setItem('hh_tags_expanded', isExpanded ? '1' : '0'); } catch {}
        renderTags();
        if (searchInput) searchInput.focus();
        // Stop so trackingPage.js doesn't treat "See more" as a search query
        e.stopPropagation();
      }
      // Non-toggle clicks: let event bubble to trackingPage.js
    });
  }

  loadPopularServices();
});
