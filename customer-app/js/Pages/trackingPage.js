(() => {
  const STORAGE_KEY = "tracking_recent_searches_v1";
  const MAX_RECENT_ITEMS = 5;
  const FALLBACK_RECENT_SEARCHES = [];
  const CUSTOMER_RECENT_SEARCHES_FIELD = "recentSearches";
  const CUSTOMER_RECENT_SEARCHES_UPDATED_AT_FIELD = "recentSearchesUpdatedAt";
  const RECENT_CLOCK_ICON_PATH = "../shared/assets/icons/recent-clock.png";
  const AUTH_WAIT_TIMEOUT_MS = 3000;
  const AUTH_WAIT_POLL_MS = 150;

  const backButton = document.querySelector(".back-btn");
  const searchInput = document.querySelector("#tracking-search-input");
  const searchSubmitButton = document.querySelector(".search-submit");
  const searchSubmitIcon = document.querySelector(".click-to-search");
  const resultsGroup = document.querySelector(".search-results-group");
  const resultsMessage = document.querySelector(".results-message");
  const resultsList = document.querySelector(".results-list");
  const clearRecentButton = document.querySelector(".clear-btn");
  const recentList = document.querySelector(".history-list");
  const chatButton = document.querySelector(".chat-btn");
  const aiActionButton = document.querySelector(".ai-action");
  const state = {
    recentSearches: [],
    syncController: null,
    syncControllerPromise: null,
    hydrationVersion: 0
  };

  function normalizeQuery(value) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeRecentSearches(items) {
    if (!Array.isArray(items)) return [];
    const deduped = [];

    items.forEach((item) => {
      const query = normalizeQuery(String(item));
      if (!query) return;

      const exists = deduped.some(
        (existingItem) => existingItem.toLowerCase() === query.toLowerCase()
      );

      if (!exists) {
        deduped.push(query);
      }
    });

    return deduped.slice(0, MAX_RECENT_ITEMS);
  }

  function mergeRecentSearches(primaryList, secondaryList) {
    return sanitizeRecentSearches([...(primaryList || []), ...(secondaryList || [])]);
  }

  function readRecentSearchesFromLocalStorage() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;

      return sanitizeRecentSearches(parsed);
    } catch (error) {
      return null;
    }
  }

  function areRecentSearchListsEqual(firstList, secondList) {
    if (!Array.isArray(firstList) || !Array.isArray(secondList)) return false;
    if (firstList.length !== secondList.length) return false;

    for (let index = 0; index < firstList.length; index += 1) {
      if (normalizeQuery(firstList[index]) !== normalizeQuery(secondList[index])) {
        return false;
      }
    }

    return true;
  }

  function saveRecentSearchesToLocalStorage(items) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (error) {
      // Ignore storage errors in private mode or restricted environments.
    }
  }

  function renderRecentSearches(items) {
    if (!recentList) return;

    if (!items.length) {
      recentList.innerHTML =
        '<li class="history-empty">No recent searches yet. Start searching to build your history.</li>';
      if (clearRecentButton) {
        clearRecentButton.hidden = true;
      }
      return;
    }

    recentList.innerHTML = items
      .map(
        (query) => `
          <li data-query="${escapeHtml(query)}">
            <img src="${RECENT_CLOCK_ICON_PATH}" alt="">
            ${escapeHtml(query)}
            <button type="button" class="remove" aria-label="Remove search ${escapeHtml(query)}">&times;</button>
          </li>
        `
      )
      .join("");

    if (clearRecentButton) {
      clearRecentButton.hidden = false;
    }
  }

  function renderSearchResults(matches, searchTerm) {
    if (!resultsGroup || !resultsMessage || !resultsList) return;
    resultsGroup.hidden = false;
    resultsList.innerHTML = "";

    if (!matches.length) {
      resultsMessage.textContent = `No results found for "${searchTerm}".`;
      resultsGroup.classList.add("search-results-empty");
      return;
    }

    resultsGroup.classList.remove("search-results-empty");
    resultsMessage.textContent = `Found ${matches.length} result${matches.length === 1 ? "" : "s"} for "${searchTerm}"`;
    resultsList.innerHTML = matches
      .map(
        ({ title, subtitle }) =>
          `<li class="result-item"><strong>${escapeHtml(title)}</strong>${subtitle ? `<span class="result-subtitle">${escapeHtml(subtitle)}</span>` : ""}</li>`
      )
      .join("");
  }

  function hideSearchResults() {
    if (!resultsGroup || !resultsMessage || !resultsList) return;
    resultsGroup.hidden = true;
    resultsMessage.textContent = "";
    resultsList.innerHTML = "";
  }

  const SEARCH_INDEX = [
    { title: "Fix leaking pipe", subtitle: "Plumbing service" },
    { title: "Install ceiling fan", subtitle: "Electrical service" },
    { title: "Emergency electrician", subtitle: "Electrical service" },
    { title: "Clean air conditioner", subtitle: "Cooling service" },
    { title: "Paint my room", subtitle: "Painting service" },
    { title: "Carpentry", subtitle: "Carpentry service" },
    { title: "Welding", subtitle: "Welding service" },
    { title: "Plumbing", subtitle: "Plumbing service" },
    { title: "Electrical", subtitle: "Electrical service" },
    { title: "Cooling", subtitle: "Cooling service" }
  ];

  function querySearchIndex(query) {
    const normalized = normalizeQuery(query).toLowerCase();
    if (!normalized) return [];
    return SEARCH_INDEX.filter((item) =>
      item.title.toLowerCase().includes(normalized) ||
      item.subtitle.toLowerCase().includes(normalized)
    );
  }

  function placeCaretAtEnd(input) {
    if (!input) return;
    const valueLength = input.value.length;
    input.focus();
    if (typeof input.setSelectionRange === "function") {
      input.setSelectionRange(valueLength, valueLength);
    }
  }

  function fillSearch(query) {
    if (!searchInput) return;
    const value = normalizeQuery(query);
    if (!value) return;
    searchInput.value = value;
    placeCaretAtEnd(searchInput);
  }

  function performSearch(query) {
    const cleanQuery = normalizeQuery(query);
    if (!cleanQuery) return;
    fillSearch(cleanQuery);
    addRecentSearch(cleanQuery);
    const results = querySearchIndex(cleanQuery);
    renderSearchResults(results, cleanQuery);
    return results;
  }

  function getSearchQueryFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return normalizeQuery(params.get("q") || "");
    } catch (error) {
      return "";
    }
  }

  function hydrateSearchQueryFromUrl() {
    const query = getSearchQueryFromUrl();
    if (!query) return;
    const results = performSearch(query);
    if (!results || !results.length) {
      window.history.replaceState({}, document.title, "tracking.html");
    }
  }

  async function waitForCurrentUser(authRepository) {
    if (!authRepository || typeof authRepository.getCurrentUser !== "function") return null;

    const immediateUser = authRepository.getCurrentUser();
    if (immediateUser && immediateUser.uid) return immediateUser;

    const startedAt = Date.now();
    while (Date.now() - startedAt < AUTH_WAIT_TIMEOUT_MS) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, AUTH_WAIT_POLL_MS);
      });

      const user = authRepository.getCurrentUser();
      if (user && user.uid) {
        return user;
      }
    }

    return authRepository.getCurrentUser();
  }

  async function createRecentSearchesSyncController() {
    try {
      const { getAppContainer } = await import("../../../shared/js/app/container.js");
      const appContainer = getAppContainer();
      const authRepository = appContainer?.repositories?.authRepository;
      const customerRepository = appContainer?.repositories?.customerRepository;
      if (!authRepository || !customerRepository) return null;

      const currentUser = await waitForCurrentUser(authRepository);
      if (!currentUser || !currentUser.uid) return null;

      const userId = currentUser.uid;
      return {
        userId,
        async loadRecentSearches() {
          const customer = await customerRepository.getById(userId);
          if (!customer || !customer.exists || !customer.data) return [];
          return sanitizeRecentSearches(customer.data[CUSTOMER_RECENT_SEARCHES_FIELD]);
        },
        async saveRecentSearches(items) {
          await customerRepository.upsert(
            userId,
            {
              [CUSTOMER_RECENT_SEARCHES_FIELD]: sanitizeRecentSearches(items),
              [CUSTOMER_RECENT_SEARCHES_UPDATED_AT_FIELD]: new Date().toISOString()
            },
            { merge: true }
          );
        }
      };
    } catch (error) {
      console.error("Recent search sync setup failed:", error);
      return null;
    }
  }

  async function getRecentSearchesSyncController() {
    if (state.syncController) {
      return state.syncController;
    }

    if (!state.syncControllerPromise) {
      state.syncControllerPromise = createRecentSearchesSyncController()
        .then((controller) => {
          state.syncController = controller;
          state.syncControllerPromise = null;
          return controller;
        })
        .catch((error) => {
          state.syncControllerPromise = null;
          console.error("Recent search sync controller creation failed:", error);
          return null;
        });
    }

    return state.syncControllerPromise;
  }

  async function syncRecentSearchesToFirestore(items) {
    const controller = await getRecentSearchesSyncController();
    if (!controller) return;

    try {
      await controller.saveRecentSearches(items);
    } catch (error) {
      console.error("Recent searches Firestore sync failed:", error);
    }
  }

  function persistRecentSearches(items, options = {}) {
    const { syncRemote = true } = options;
    const nextItems = sanitizeRecentSearches(items);
    state.recentSearches = nextItems;
    saveRecentSearchesToLocalStorage(nextItems);
    renderRecentSearches(nextItems);

    if (syncRemote) {
      void syncRecentSearchesToFirestore(nextItems);
    }
  }

  function addRecentSearch(query) {
    const cleanQuery = normalizeQuery(query);
    if (!cleanQuery) return;

    const withoutDuplicate = state.recentSearches.filter(
      (item) => item.toLowerCase() !== cleanQuery.toLowerCase()
    );
    persistRecentSearches([cleanQuery, ...withoutDuplicate]);
  }

  function removeRecentSearch(queryToRemove) {
    const normalizedQuery = normalizeQuery(queryToRemove).toLowerCase();
    if (!normalizedQuery) return;

    const nextItems = state.recentSearches.filter(
      (item) => item.toLowerCase() !== normalizedQuery
    );
    persistRecentSearches(nextItems);
  }

  function clearAllRecentSearches() {
    state.hydrationVersion += 1;
    persistRecentSearches([]);
    if (searchInput) {
      searchInput.value = "";
    }
  }

  function getTextWithoutRemoveControl(listItem) {
    if (!listItem) return "";
    const clonedItem = listItem.cloneNode(true);
    const removeControl = clonedItem.querySelector(".remove");
    if (removeControl) {
      removeControl.remove();
    }

    const iconImage = clonedItem.querySelector("img");
    if (iconImage) {
      iconImage.remove();
    }

    return normalizeQuery(clonedItem.textContent || "");
  }

  function wireBackButton() {
    if (!backButton) return;
    backButton.onclick = null;
    backButton.addEventListener("click", (event) => {
      event.preventDefault();
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      window.location.href = "index.html";
    });
  }

  function wirePopularTags() {
    document.querySelectorAll(".tag-cloud .search-tag").forEach((tag) => {
      tag.addEventListener("click", () => {
        const rawText = normalizeQuery(tag.textContent || "");
        if (!rawText) return;

        if (/^see more/i.test(rawText)) {
          const categorySection = document.querySelector(".cat-grid");
          if (categorySection && typeof categorySection.scrollIntoView === "function") {
            categorySection.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          return;
        }

        performSearch(rawText);
      });
    });
  }

  function wireCategories() {
    document.querySelectorAll(".cat-grid .cat-box").forEach((category) => {
      category.addEventListener("click", () => {
        const label = normalizeQuery(
          category.querySelector("span:last-child")?.textContent || ""
        );
        if (!label) return;
        performSearch(label);
      });
    });
  }

  function wireAIButton() {
    if (!aiActionButton) return;

    aiActionButton.addEventListener("click", () => {
      const promptText =
        window.prompt("Describe your issue and we will prepare a smart search for you:") || "";
      const issue = normalizeQuery(promptText);
      if (!issue) return;

      performSearch(issue);
    });
  }

  function wireRecentHistory() {
    if (!recentList) return;

    recentList.addEventListener("click", (event) => {
      const removeButton = event.target.closest(".remove");
      if (removeButton) {
        event.preventDefault();
        event.stopPropagation();
        const item = removeButton.closest("li");
        const query = item?.dataset.query || getTextWithoutRemoveControl(item);
        if (query) {
          removeRecentSearch(query);
        }
        return;
      }

      const item = event.target.closest("li");
      if (!item || item.classList.contains("history-empty")) return;
      const query = item.dataset.query || getTextWithoutRemoveControl(item);
      if (!query) return;
      performSearch(query);
    });

    recentList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const removeButton = event.target.closest(".remove");
      if (!removeButton) return;
      event.preventDefault();
      const item = removeButton.closest("li");
      const query = item?.dataset.query || getTextWithoutRemoveControl(item);
      if (query) {
        removeRecentSearch(query);
      }
    });
  }

  function wireClearRecent() {
    if (!clearRecentButton) return;
    clearRecentButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearAllRecentSearches();
    });
  }

  function wireSearchInput() {
    if (!searchInput) return;

    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const query = normalizeQuery(searchInput.value);
      if (!query) return;
      const results = performSearch(query);
      if (!results || !results.length) {
        window.location.href = "search-not-found.html?q=" + encodeURIComponent(query);
      }
    });
    searchInput.addEventListener("input", (event) => {
      const query = normalizeQuery(event.target.value);
      if (!query) {
        hideSearchResults();
        return;
      }
      const results = querySearchIndex(query);
      renderSearchResults(results, query);
    });
  }

  function wireSearchSubmitButton() {
    if (!searchInput) return;

    const submitHandler = () => {
      const query = normalizeQuery(searchInput.value);
      if (!query) return;
      const results = performSearch(query);
      if (!results || !results.length) {
        window.location.href = "search-not-found.html?q=" + encodeURIComponent(query);
        return;
      }
      searchInput.focus();
    };

    if (searchSubmitButton) {
      searchSubmitButton.addEventListener("click", submitHandler);
    }

    if (searchSubmitIcon) {
      searchSubmitIcon.addEventListener("click", submitHandler);
    }
  }

  function wireChatButton() {
    if (!chatButton) return;
    chatButton.addEventListener("click", () => {
      const supportPage = "message.html";
      window.location.href = supportPage;
    });
  }

  async function hydrateRecentSearchesFromSources() {
    const hydrationToken = ++state.hydrationVersion;
    const localSearches = readRecentSearchesFromLocalStorage();
    const hasLocalSearches = Array.isArray(localSearches);
    const initialSearches = hasLocalSearches ? localSearches : [...FALLBACK_RECENT_SEARCHES];
    state.recentSearches = sanitizeRecentSearches(initialSearches);
    renderRecentSearches(state.recentSearches);

    const controller = await getRecentSearchesSyncController();
    if (!controller) return;

    try {
      const remoteSearches = await controller.loadRecentSearches();
      if (hydrationToken !== state.hydrationVersion) return;

      if (remoteSearches.length > 0) {
        const mergedSearches = hasLocalSearches
          ? mergeRecentSearches(remoteSearches, localSearches)
          : remoteSearches;
        persistRecentSearches(mergedSearches, { syncRemote: false });

        if (!areRecentSearchListsEqual(mergedSearches, remoteSearches)) {
          await controller.saveRecentSearches(mergedSearches);
        }
        return;
      }

      if (hasLocalSearches) {
        persistRecentSearches(localSearches, { syncRemote: false });
        await controller.saveRecentSearches(localSearches);
      }
    } catch (error) {
      if (hydrationToken !== state.hydrationVersion) return;
      console.error("Failed to hydrate recent searches from Firestore:", error);
    }
  }

  function init() {
    wireBackButton();
    wirePopularTags();
    wireCategories();
    wireAIButton();
    wireRecentHistory();
    wireClearRecent();
    wireSearchInput();
    wireSearchSubmitButton();
    wireChatButton();
    hydrateSearchQueryFromUrl();
    void hydrateRecentSearchesFromSources();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
