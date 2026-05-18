// --- SEARCH CAPTURE & RECENT HISTORY STORAGE ENGINE ---
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('tracking-search-input');
  const tagCloud = document.querySelector('.tag-cloud');
  const searchSubmitBtn = document.querySelector('.search-submit');
  const historyList = document.querySelector('.history-list');
  const clearAllBtn = document.querySelector('.clear-btn');
  const catGrid = document.querySelector('.cat-grid');

  // Load and display items from storage (strict cap at 5)
  function renderRecentHistory() {
    if (!historyList) return;
    
    const history = JSON.parse(localStorage.getItem('recentSearches')) || [];
    
    if (history.length === 0) {
      historyList.innerHTML = '<li class="no-history-msg" style="list-style:none; color:#777; padding:8px 0;">No recent searches</li>';
      return;
    }

    historyList.innerHTML = history.map(term => `
      <li class="history-item" style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #eee;">
        <span class="history-term" data-search="${term}" style="cursor:pointer; display:flex; align-items:center; gap:8px; width:100%;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#777" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${term}
        </span>
        <button class="delete-history-item" data-search="${term}" style="background:none; border:none; color:#999; cursor:pointer; font-size:16px; padding:0 8px;">&times;</button>
      </li>
    `).join('');
  }

  // Save unique search query up to 5 max items
  function saveSearchQuery(query) {
    if (!query || !query.trim()) return;
    const cleanQuery = query.trim();

    let history = JSON.parse(localStorage.getItem('recentSearches')) || [];
    
    // Deduplication rule
    history = history.filter(item => item.toLowerCase() !== cleanQuery.toLowerCase());
    history.unshift(cleanQuery);

    if (history.length > 5) {
      history = history.slice(0, 5);
    }

    localStorage.setItem('recentSearches', JSON.stringify(history));
    renderRecentHistory();
  }

  // Initialize display list on load
  renderRecentHistory();

  // Capture selections from Popular Searches Tag Cloud (ignores toggle button)
  if (tagCloud) {
    tagCloud.addEventListener('click', (event) => {
      const clickedTag = event.target.closest('.search-tag');
      if (!clickedTag || clickedTag.classList.contains('toggle-expand')) return;

      const queryValue = clickedTag.getAttribute('data-search');
      if (queryValue && searchInput) {
        searchInput.value = queryValue;
        searchInput.focus();
        saveSearchQuery(queryValue);
      }
    });
  }

  // Capture selections from Search by Category Grid (ignores "More" button)
  if (catGrid) {
    catGrid.addEventListener('click', (event) => {
      const clickedCat = event.target.closest('.cat-box');
      if (!clickedCat) return;
      
      const catText = clickedCat.querySelector('span:not(.circle)')?.textContent.trim() || '';
      if (catText && catText !== 'More' && searchInput) {
        searchInput.value = catText;
        searchInput.focus();
        saveSearchQuery(catText);
      }
    });
  }

  // Capture input key presses ('Enter' key submission)
  if (searchInput) {
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        saveSearchQuery(searchInput.value);
      }
    });
  }

  // Capture search magnifying icon button clicks
  if (searchSubmitBtn) {
    searchSubmitBtn.addEventListener('click', () => {
      if (searchInput) {
        saveSearchQuery(searchInput.value);
      }
    });
  }

  // Manage individual row click actions (re-searching or row deletion)
  if (historyList) {
    historyList.addEventListener('click', (event) => {
      const termBtn = event.target.closest('.history-term');
      const deleteBtn = event.target.closest('.delete-history-item');

      if (termBtn && searchInput) {
        const query = termBtn.getAttribute('data-search');
        searchInput.value = query;
        searchInput.focus();
        saveSearchQuery(query); 
      } else if (deleteBtn) {
        const queryToDelete = deleteBtn.getAttribute('data-search');
        let history = JSON.parse(localStorage.getItem('recentSearches')) || [];
        history = history.filter(item => item !== queryToDelete);
        localStorage.setItem('recentSearches', JSON.stringify(history));
        renderRecentHistory();
      }
    });
  }

  // Manage Clear All button interactions
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      localStorage.removeItem('recentSearches');
      renderRecentHistory();
    });
  }
});
