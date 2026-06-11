/**
 * trackingPage.js  — Search UI controller for search-page.html
 *
 * Responsibilities:
 *   • Manage search input, submit, results display
 *   • Delegate all history persistence to SearchHistoryService
 *   • Wire up category tiles and popular-search tags
 *   • Handle ?q= URL parameter for cross-page deep-links
 *
 * ─── SEARCH ARCHITECTURE ────────────────────────────────────────────────────
 * All search results come from artisanRepository.searchByKeyword() which
 * queries the 'artisans' Firestore collection using array-contains on the
 * artisan's searchKeywords field. Only artisans with verificationStatus ==
 * 'approved' are surfaced. Results are sorted by rating descending.
 *
 * Multi-word queries ("emergency plumber") use array-contains-any so artisans
 * matching ANY token in the query are returned (full phrase match is attempted
 * first as a token for higher precision).
 *
 * The DI container is loaded via a module-level IIFE so Firebase is ready
 * before the user types — both the search path and the history path share the
 * same container promise.
 *
 * ─── PARTIAL MATCH LIMITATION ───────────────────────────────────────────────
 * Firestore array-contains is exact-match only. "plumb" will NOT match
 * "plumber". The CATEGORY_SYNONYMS table in artisanRepository pre-indexes the
 * most common variants so this limitation is largely invisible in practice.
 * For true fuzzy/prefix search, migrate to Algolia, Typesense, or Meilisearch.
 */

import { SearchHistoryService } from '../../../shared/js/services/searchHistoryService.js';
// ↑ Pure JS class — no CDN dependency — safe to import statically.
// The DI container (and Firebase SDK) is loaded dynamically below.

// ── DI container — starts loading immediately at module parse time ────────────
// Both search (artisan repo) and history (auth + customer repo) share this one
// promise. By the time boot() runs and the user types, it is almost always ready.
const _containerReady = (async () => {
    try {
        const { getAppContainer } = await import('../../../shared/js/app/container.js');
        return getAppContainer();
    } catch (err) {
        console.warn('[search-page] DI container init failed:', err?.message);
        return null;
    }
})();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const searchInput      = document.querySelector('#tracking-search-input');
const searchSubmitBtn  = document.querySelector('.search-submit');
const searchSubmitIcon = document.querySelector('.click-to-search');
const resultsGroup     = document.querySelector('.search-results-group');
const resultsMessage   = document.querySelector('.results-message');
const resultsList      = document.querySelector('.results-list');
const recentList       = document.querySelector('.history-list');
const clearAllBtn      = document.querySelector('.clear-btn');
const backBtn          = document.querySelector('.back-btn');
const chatBtn          = document.querySelector('.chat-btn');
const aiActionBtn      = document.querySelector('.ai-action');

// ── Service ───────────────────────────────────────────────────────────────────
const historyService = new SearchHistoryService();

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function norm(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
}

// ── Firestore search ──────────────────────────────────────────────────────────

/**
 * Map a raw artisan Firestore record to a UI result item.
 *
 * title     → artisan display name — specialty (e.g. "Kwame Asante — Plumber")
 * subtitle  → category displayed as secondary line (e.g. "Plumbing")
 * artisanId → stored in sessionStorage on click; consumed by book-now.html
 * rating    → shown as ⭐ badge; 0 means no reviews yet (not displayed)
 */
function toResultItem(record) {
    const d        = record.data || {};
    const name     = (d.name      || '').trim();
    const specialty = (d.specialty || '').trim();
    const category  = (d.category  || specialty || '').trim();
    return {
        title:     name && specialty ? `${name} — ${specialty}` : (name || specialty || 'Artisan'),
        subtitle:  category,
        artisanId: record.id  || '',
        rating:    typeof d.rating === 'number' ? d.rating : 0,
    };
}

/**
 * Query Firestore via the artisan repository.
 * Returns { results: ResultItem[], error: string|null }.
 * Never throws — all exceptions are caught and surface as { error }.
 */
async function queryFirestore(term) {
    try {
        const container = await _containerReady;
        if (!container) {
            return { results: [], error: 'Search unavailable. Please check your connection and try again.' };
        }
        const artisans = await container.repositories.artisanRepository.searchByKeyword(term);
        return { results: artisans.map(toResultItem), error: null };
    } catch (err) {
        console.error('[search-page] Firestore search error:', err?.message);
        return { results: [], error: 'Search temporarily unavailable. Please try again.' };
    }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderHistory(items) {
    if (!recentList) return;

    if (!Array.isArray(items) || items.length === 0) {
        recentList.innerHTML = '<li class="history-empty">No recent searches yet.</li>';
        if (clearAllBtn) clearAllBtn.hidden = true;
        return;
    }

    recentList.innerHTML = items.map(q => `
        <li data-query="${escHtml(q)}" role="listitem">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span class="history-term">${escHtml(q)}</span>
            <button type="button" class="remove" aria-label="Remove ${escHtml(q)} from history">&times;</button>
        </li>
    `).join('');

    if (clearAllBtn) clearAllBtn.hidden = false;
}

/**
 * Render search results from Firestore into the results panel.
 * Each item includes artisanId + rating from real artisan data.
 */
function renderResults(matches, term) {
    if (!resultsGroup || !resultsMessage || !resultsList) return;
    resultsGroup.hidden = false;

    if (!matches.length) {
        resultsMessage.textContent = `No results for "${term}"`;
        resultsGroup.classList.add('search-results-empty');
        resultsList.innerHTML = '';
        return;
    }

    resultsGroup.classList.remove('search-results-empty');
    resultsMessage.textContent = `${matches.length} result${matches.length === 1 ? '' : 's'} for "${term}"`;
    resultsList.innerHTML = matches.map(m => {
        const hasRating = m.rating && m.rating > 0;
        return `<li class="result-item"
                    data-title="${escHtml(m.title)}"
                    data-subtitle="${escHtml(m.subtitle || '')}"
                    data-artisanid="${escHtml(m.artisanId || '')}"
                    tabindex="0" role="button">
                    <div class="result-item-body">
                        <strong>${escHtml(m.title)}</strong>
                        ${m.subtitle ? `<span class="result-subtitle">${escHtml(m.subtitle)}</span>` : ''}
                    </div>
                    ${hasRating ? `<span class="result-rating">&#11088; ${Number(m.rating).toFixed(1)}</span>` : ''}
                </li>`;
    }).join('');
}

/** Show "Searching…" feedback while the Firestore query is in flight. */
function renderSearchingState(term) {
    if (!resultsGroup || !resultsMessage || !resultsList) return;
    resultsGroup.hidden = false;
    resultsGroup.classList.remove('search-results-empty');
    resultsMessage.textContent = `Searching for "${term}"…`;
    resultsList.innerHTML = '';
}

/** Show a non-fatal inline error (offline, Firestore unavailable). */
function renderErrorState(message) {
    if (!resultsGroup || !resultsMessage || !resultsList) return;
    resultsGroup.hidden = false;
    resultsGroup.classList.add('search-results-empty');
    resultsMessage.textContent = message;
    resultsList.innerHTML = '';
}

function hideResults() {
    if (!resultsGroup) return;
    resultsGroup.hidden = true;
    if (resultsMessage) resultsMessage.textContent = '';
    if (resultsList)    resultsList.innerHTML = '';
}

// ── Search logic ──────────────────────────────────────────────────────────────

function fillInput(value) {
    if (!searchInput) return;
    searchInput.value = norm(value);
    const len = searchInput.value.length;
    searchInput.focus();
    try { searchInput.setSelectionRange(len, len); } catch { /* non-text input */ }
}

/**
 * Full search: fill input + save to history + query Firestore + render.
 * Used by: Enter key, Submit button, category tiles, popular tags, history re-runs.
 * Returns { term, results, error } so callers can decide whether to redirect.
 */
async function executeSearch(query) {
    const q = norm(query);
    if (!q) return { term: q, results: [], error: null };

    fillInput(q);
    historyService.add(q);        // optimistic; async Firestore write in the background
    renderSearchingState(q);

    const { results, error } = await queryFirestore(q);

    if (error) {
        renderErrorState(error);
        return { term: q, results: [], error };
    }

    renderResults(results, q);
    return { term: q, results, error: null };
}

// ── Live-input debounced search (input event — no history save, no redirect) ──

let _debounceTimer = null;
let _activeTerm    = '';   // newest in-flight term; older results are discarded

function scheduleSearch(term) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => void runSearch(term), 300);
}

async function runSearch(term) {
    _activeTerm = term;
    renderSearchingState(term);

    const { results, error } = await queryFirestore(term);

    // Stale-result guard: if the user typed a new term while this query was
    // in-flight, discard this result — the newer query will render its own.
    if (_activeTerm !== term) return;

    if (error) { renderErrorState(error); return; }
    renderResults(results, term);
}

// ── URL param hydration ───────────────────────────────────────────────────────

async function hydrateFromUrl() {
    try {
        const q = norm(new URLSearchParams(window.location.search).get('q') || '');
        if (!q) return;
        const { results } = await executeSearch(q);
        if (!results.length) {
            window.history.replaceState({}, document.title, 'search-page.html');
        }
    } catch { /* malformed URL — ignore */ }
}

// ── Service initialization ────────────────────────────────────────────────────

async function initHistoryService() {
    try {
        const container = await _containerReady;
        if (!container) return;

        const { services: { authService }, repositories: { customerRepository } } = container;

        // authService.waitForUser() is non-polling — resolves on auth state change
        const user = await authService.waitForUser();
        if (!user?.uid) return;   // anonymous / logged out — localStorage only

        await historyService.init(user.uid, customerRepository);
    } catch (err) {
        console.warn('[search-page] History service init failed:', err?.message);
        // SearchHistoryService falls back to localStorage silently — no disruption
    }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireSearchInput() {
    if (!searchInput) return;

    // Live search: debounced, stale-result protected, no history save
    searchInput.addEventListener('input', () => {
        const q = norm(searchInput.value);
        if (!q) { hideResults(); return; }
        scheduleSearch(q);
    });

    // Enter: full search + redirect to search-not-found if no results
    searchInput.addEventListener('keydown', async e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q = norm(searchInput.value);
        if (!q) return;
        clearTimeout(_debounceTimer);   // cancel any pending live search
        const { results } = await executeSearch(q);
        if (!results.length) {
            window.location.href = `search-not-found.html?q=${encodeURIComponent(q)}`;
        }
    });
}

function wireSubmitButton() {
    const handle = async () => {
        const q = norm(searchInput?.value || '');
        if (!q) return;
        clearTimeout(_debounceTimer);
        const { results } = await executeSearch(q);
        if (!results.length) {
            window.location.href = `search-not-found.html?q=${encodeURIComponent(q)}`;
        } else if (searchInput) {
            searchInput.focus();
        }
    };
    if (searchSubmitBtn)  searchSubmitBtn.addEventListener('click', handle);
    if (searchSubmitIcon) searchSubmitIcon.addEventListener('click', handle);
}

/**
 * Delegated click handler for search result items.
 * Survives every innerHTML replacement inside renderResults().
 * Navigates to book-now.html with the artisan's service category pre-selected
 * and stores the artisan ID in sessionStorage for the booking flow.
 */
function wireResultItems() {
    if (!resultsList) return;

    function navigate(item) {
        const subtitle  = item.dataset.subtitle  || '';
        const title     = item.dataset.title     || '';
        const artisanId = item.dataset.artisanid || '';
        if (subtitle)  sessionStorage.setItem('hh_service', subtitle);
        if (title)     sessionStorage.setItem('hh_task', title);
        if (artisanId) sessionStorage.setItem('hh_search_artisan_id', artisanId);
        window.location.href = 'book-now.html';
    }

    resultsList.addEventListener('click', e => {
        const item = e.target.closest('.result-item[data-title]');
        if (item) navigate(item);
    });

    resultsList.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.result-item[data-title]');
        if (!item) return;
        e.preventDefault();
        navigate(item);
    });
}

function wireRecentList() {
    if (!recentList) return;

    recentList.addEventListener('click', e => {
        // Remove button
        const removeBtn = e.target.closest('.remove');
        if (removeBtn) {
            e.preventDefault();
            e.stopPropagation();
            const li    = removeBtn.closest('li[data-query]');
            const query = li?.dataset.query;
            if (query) historyService.remove(query);
            return;
        }

        // Clicking anywhere else on an item re-runs the search
        const li = e.target.closest('li[data-query]');
        if (!li || li.classList.contains('history-empty')) return;
        const query = li.dataset.query;
        if (query) {
            executeSearch(query).catch(err =>
                console.error('[search-page] History re-run failed:', err?.message)
            );
        }
    });

    recentList.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const removeBtn = e.target.closest('.remove');
        if (!removeBtn) return;
        e.preventDefault();
        const li    = removeBtn.closest('li[data-query]');
        const query = li?.dataset.query;
        if (query) historyService.remove(query);
    });
}

function wireClearAll() {
    if (!clearAllBtn) return;
    clearAllBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        historyService.clear();
        if (searchInput) searchInput.value = '';
        hideResults();
    });
}

function wireCategories() {
    document.querySelectorAll('.cat-grid .cat-box').forEach(box => {
        box.addEventListener('click', () => {
            const label = norm(box.querySelector('span:last-child')?.textContent || '');
            if (!label) return;
            // "More" has no search value — send to full service catalogue
            if (label.toLowerCase() === 'more') {
                window.location.href = 'book-step1.html';
                return;
            }
            executeSearch(label).catch(err =>
                console.error('[search-page] Category search failed:', err?.message)
            );
        });
    });
}

function wirePopularTags() {
    // Only wires non-toggle tags. The expand/collapse toggle is handled
    // by script.js (which owns the renderTags / isExpanded state).
    document.querySelector('.tag-cloud')?.addEventListener('click', e => {
        const tag = e.target.closest('.search-tag');
        if (!tag || tag.classList.contains('toggle-expand')) return;
        const query = norm(tag.getAttribute('data-search') || tag.textContent || '');
        if (query) {
            executeSearch(query).catch(err =>
                console.error('[search-page] Tag search failed:', err?.message)
            );
        }
    });
}

function wireBackButton() {
    if (!backBtn) return;
    backBtn.addEventListener('click', e => {
        e.preventDefault();
        window.location.href = 'dashboard.html';
    });
}

function wireChatButton() {
    if (!chatBtn) return;
    chatBtn.addEventListener('click', () => {
        window.location.href = 'messages.html';
    });
}

function wireAiButton() {
    if (!aiActionBtn) return;
    // window.prompt() is blocked in iOS Safari PWA mode, many Android WebViews,
    // and all Capacitor builds. Focus the search input instead.
    aiActionBtn.addEventListener('click', () => {
        if (searchInput) searchInput.focus();
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
    // Subscribe to history service — single render path for all history changes
    historyService.subscribe(renderHistory);

    wireSearchInput();
    wireSubmitButton();
    wireResultItems();    // delegated listener must come before any innerHTML render
    wireRecentList();
    wireClearAll();
    wireCategories();
    wirePopularTags();
    wireBackButton();
    wireChatButton();
    wireAiButton();

    // Process ?q= before kicking off async Firestore hydration
    void hydrateFromUrl();

    // Auth + history Firestore sync — fire-and-forget; cannot block event listeners
    void initHistoryService();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
