/**
 * trackingPage.js  — Search UI controller for search-page.html
 *
 * Responsibilities:
 *   • Manage search input, submit, results display
 *   • Delegate all history operations to SearchHistoryService
 *   • Wire up category tiles and popular-search tags
 *   • Handle ?q= URL parameter for cross-page deep-links
 *
 * This file is intentionally thin. All persistence, sync, deduplication
 * and Firestore I/O lives in SearchHistoryService.
 *
 * ARCHITECTURE NOTE — dynamic import for getAppContainer:
 * ────────────────────────────────────────────────────────
 * getAppContainer chains through Firebase SDK modules loaded from a CDN URL
 * (gstatic.com). A static top-level import would put that CDN fetch on the
 * critical path: if it's slow or blocked, the entire module fails at parse
 * time, boot() is never called, and zero event listeners are attached.
 *
 * The fix: import getAppContainer dynamically *inside* initHistoryService()
 * (which is fire-and-forget). If the CDN import fails, only history sync is
 * affected — all event listeners are already wired, the page stays functional,
 * and SearchHistoryService falls back to localStorage automatically.
 */

import { SearchHistoryService } from '../../../shared/js/services/searchHistoryService.js';
// ↑ Pure JS class — no CDN dependency — safe to import statically.
// getAppContainer is imported dynamically inside initHistoryService() below.

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

// ── Static search index (replace with Firestore query when catalogue is built)
const SEARCH_INDEX = [
    { title: 'Fix leaking pipe',       subtitle: 'Plumbing' },
    { title: 'Install ceiling fan',    subtitle: 'Electrical' },
    { title: 'Emergency electrician',  subtitle: 'Electrical' },
    { title: 'Clean air conditioner',  subtitle: 'Cooling' },
    { title: 'Paint my room',          subtitle: 'Painting' },
    { title: 'Carpentry',              subtitle: 'Carpentry' },
    { title: 'Welding',                subtitle: 'Welding' },
    { title: 'Plumbing',               subtitle: 'Plumbing' },
    { title: 'Electrical',             subtitle: 'Electrical' },
    { title: 'Cooling',                subtitle: 'Cooling' },
    { title: 'Tiling',                 subtitle: 'Tiling' },
    { title: 'Cleaning',               subtitle: 'Cleaning' },
];

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
    // data-title / data-subtitle are read by the delegated listener in wireResultItems()
    resultsList.innerHTML = matches.map(({ title, subtitle }) =>
        `<li class="result-item" data-title="${escHtml(title)}" data-subtitle="${escHtml(subtitle || '')}">
            <strong>${escHtml(title)}</strong>
            ${subtitle ? `<span class="result-subtitle">${escHtml(subtitle)}</span>` : ''}
        </li>`
    ).join('');
}

function hideResults() {
    if (!resultsGroup) return;
    resultsGroup.hidden = true;
    if (resultsMessage) resultsMessage.textContent = '';
    if (resultsList)    resultsList.innerHTML = '';
}

// ── Search logic ──────────────────────────────────────────────────────────────

function queryIndex(query) {
    const lower = norm(query).toLowerCase();
    if (!lower) return [];
    return SEARCH_INDEX.filter(item =>
        item.title.toLowerCase().includes(lower) ||
        item.subtitle.toLowerCase().includes(lower)
    );
}

function fillInput(value) {
    if (!searchInput) return;
    searchInput.value = norm(value);
    const len = searchInput.value.length;
    searchInput.focus();
    try { searchInput.setSelectionRange(len, len); } catch { /* non-text */ }
}

/**
 * Full search: fill input + save to history + render results.
 * Returns matches array.
 */
function executeSearch(query) {
    const q = norm(query);
    if (!q) return [];
    fillInput(q);
    historyService.add(q);               // optimistic update, async Firestore write
    const results = queryIndex(q);
    renderResults(results, q);
    return results;
}

// ── URL param hydration ───────────────────────────────────────────────────────

function hydrateFromUrl() {
    try {
        const q = norm(new URLSearchParams(window.location.search).get('q') || '');
        if (!q) return;
        const results = executeSearch(q);
        // Clean up URL after processing
        if (!results.length) {
            window.history.replaceState({}, document.title, 'search-page.html');
        }
    } catch { /* malformed URL — ignore */ }
}

// ── Service initialization ────────────────────────────────────────────────────

async function initHistoryService() {
    try {
        // Dynamic import keeps Firebase CDN off the critical boot path.
        // If this import fails (CDN blocked, offline, CSP) only history sync
        // is affected — all event listeners are already attached at this point.
        const { getAppContainer } = await import('../../../shared/js/app/container.js');

        const { services: { authService }, repositories: { customerRepository } } =
            getAppContainer();

        // authService.waitForUser() is non-polling — resolves on auth state change
        const user = await authService.waitForUser();
        if (!user?.uid) return;   // anonymous / logged out — localStorage only

        await historyService.init(user.uid, customerRepository);
    } catch (err) {
        console.warn('[TrackingPage] History service init failed:', err.message);
        // Service falls back to localStorage silently — no user disruption
    }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireSearchInput() {
    if (!searchInput) return;

    // Live filter as user types (no history save — just results preview)
    searchInput.addEventListener('input', () => {
        const q = norm(searchInput.value);
        if (!q) { hideResults(); return; }
        renderResults(queryIndex(q), q);
    });

    // Save + navigate on Enter
    searchInput.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q = norm(searchInput.value);
        if (!q) return;
        const results = executeSearch(q);
        if (!results.length) {
            window.location.href = `search-not-found.html?q=${encodeURIComponent(q)}`;
        }
    });
}

function wireSubmitButton() {
    const handle = () => {
        const q = norm(searchInput?.value || '');
        if (!q) return;
        const results = executeSearch(q);
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
 * Clicking a result navigates to book-now.html with the service
 * category pre-selected in sessionStorage for the discovery flow.
 */
function wireResultItems() {
    if (!resultsList) return;

    resultsList.addEventListener('click', e => {
        const item = e.target.closest('.result-item[data-title]');
        if (!item) return;
        const subtitle = item.dataset.subtitle || '';
        const title    = item.dataset.title    || '';
        if (subtitle) sessionStorage.setItem('hh_service', subtitle);
        if (title)    sessionStorage.setItem('hh_task', title);
        window.location.href = 'book-now.html';
    });

    // Keyboard accessibility
    resultsList.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = e.target.closest('.result-item[data-title]');
        if (!item) return;
        e.preventDefault();
        const subtitle = item.dataset.subtitle || '';
        const title    = item.dataset.title    || '';
        if (subtitle) sessionStorage.setItem('hh_service', subtitle);
        if (title)    sessionStorage.setItem('hh_task', title);
        window.location.href = 'book-now.html';
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
        if (query) executeSearch(query);
    });

    // Keyboard accessibility for remove buttons
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
            executeSearch(label);
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
        if (query) executeSearch(query);
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
    // and all Capacitor builds. Focus the search input instead — same intent,
    // works everywhere.
    aiActionBtn.addEventListener('click', () => {
        if (searchInput) searchInput.focus();
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
    // Subscribe to service — single render path for all history changes
    historyService.subscribe(renderHistory);

    wireSearchInput();
    wireSubmitButton();
    wireResultItems();    // delegated listener on resultsList — must come before any render
    wireRecentList();
    wireClearAll();
    wireCategories();
    wirePopularTags();
    wireBackButton();
    wireChatButton();
    wireAiButton();

    // Process ?q= before kicking off async Firestore hydration
    hydrateFromUrl();

    // Auth + Firestore hydration runs async and fire-and-forget.
    // All event listeners above are already attached — this cannot block them.
    void initHistoryService();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
