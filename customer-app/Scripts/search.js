// --- FIRESTORE ARTISAN SEARCH ENGINE ---
import "../../shared/js/utils/global-app.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseDb } from "../../shared/js/backend/providers/firebase/firebaseConfig.js";

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('tracking-search-input');
  const searchSubmitBtn = document.querySelector('.search-submit');
  const tagCloud = document.querySelector('.tag-cloud');
  const catGrid = document.querySelector('.cat-grid');

  const loaderOverlay = document.getElementById('search-loader');
  const resultsGroup = document.querySelector('.search-results-group');
  const resultsMessage = document.querySelector('.results-message');
  const resultsList = document.querySelector('.results-list');

  async function executeArtisanSearch(queryText) {
    const cleanQuery = String(queryText || '').trim().toLowerCase();
    if (!cleanQuery) {
      if (resultsMessage) {
        resultsMessage.textContent = 'Please enter a search term to find an artisan.';
      }
      if (resultsList) {
        resultsList.innerHTML = '';
      }
      if (resultsGroup) {
        resultsGroup.removeAttribute('hidden');
      }
      return;
    }

    if (loaderOverlay) loaderOverlay.removeAttribute('hidden');
    if (resultsGroup) resultsGroup.setAttribute('hidden', true);
    if (resultsList) resultsList.innerHTML = '';

    try {
      const artisansQuery = query(
        collection(firebaseDb, 'artisans'),
        where('searchKeywords', 'array-contains', cleanQuery)
      );
      const snapshot = await getDocs(artisansQuery);
      const artisans = snapshot.docs.map((docSnapshot) => ({
        id: docSnapshot.id,
        ...docSnapshot.data()
      }));

      if (resultsList) {
        if (artisans.length) {
          resultsList.innerHTML = artisans.map((artisan) => {
            const profileImage = artisan.profileImage || '../shared/assets/icons/default-user.png';
            return `
              <li class="artisan-card">
                <img class="artisan-avatar" src="${profileImage}" alt="${artisan.name || 'Artisan'}">
                <div class="artisan-details">
                  <strong class="artisan-name">${artisan.name || 'Unknown Artisan'}</strong>
                  <p class="artisan-specialty">${artisan.specialty || 'General Service'}</p>
                  <span class="artisan-rating">★ ${artisan.rating ?? 'N/A'} (${artisan.jobsCompleted ?? 0} jobs)</span>
                </div>
              </li>
            `;
          }).join('');
        } else {
          resultsList.innerHTML = '';
        }
      }

      if (resultsMessage) {
        resultsMessage.textContent = artisans.length
          ? `Showing ${artisans.length} professionals for "${cleanQuery}".`
          : 'No artisan found. Try again.';
      }

      if (resultsGroup) resultsGroup.removeAttribute('hidden');
    } catch (error) {
      console.error('Firestore artisan search failed:', error);
      if (resultsMessage) {
        resultsMessage.textContent = 'Unable to search artisans right now. Please try again.';
      }
      if (resultsList) {
        resultsList.innerHTML = '';
      }
      if (resultsGroup) resultsGroup.removeAttribute('hidden');
    } finally {
      setTimeout(() => {
        if (loaderOverlay) loaderOverlay.setAttribute('hidden', true);
      }, 400);
    }
  }

  if (searchInput) {
    searchInput.focus();
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        executeArtisanSearch(searchInput.value);
      }
    });
  }

  if (searchSubmitBtn) {
    searchSubmitBtn.addEventListener('click', () => {
      if (searchInput) executeArtisanSearch(searchInput.value);
    });
  }

  if (tagCloud) {
    tagCloud.addEventListener('click', (event) => {
      const clickedTag = event.target.closest('.search-tag');
      if (!clickedTag || clickedTag.classList.contains('toggle-expand')) return;
      const queryValue = clickedTag.getAttribute('data-search');
      if (queryValue) executeArtisanSearch(queryValue);
    });
  }

  if (catGrid) {
    catGrid.addEventListener('click', (event) => {
      const clickedCat = event.target.closest('.cat-box');
      if (!clickedCat) return;
      const queryValue = clickedCat.querySelector('span:not(.circle)')?.textContent.trim();
      if (queryValue && queryValue !== 'More') executeArtisanSearch(queryValue);
    });
  }
});
