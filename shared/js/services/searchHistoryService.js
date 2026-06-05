/**
 * searchHistoryService.js
 *
 * Single source of truth for HandyHub customer search history.
 *
 * Architecture:
 *   Memory (_items[])              ← live state, always current
 *   localStorage[hh_search_history] ← write-through performance cache
 *   Firestore customers/{uid}.recentSearches ← canonical persistent store
 *   localStorage[hh_search_history_pending]  ← offline retry queue
 *
 * Data flow — add(query):
 *   1. Normalize + validate
 *   2. Deduplicate (case-insensitive) + prepend
 *   3. Write to localStorage immediately (sync)
 *   4. Notify all subscribers (sync)
 *   5. Schedule debounced Firestore write (async, 800 ms)
 *   6. On write failure → queue in pending store for retry on next init()
 *
 * Data flow — init(uid):
 *   1. Load legacy keys (migration) + canonical key → render at 0 ms wait
 *   2. Flush any pending offline writes
 *   3. Load from Firestore
 *   4. Merge: Firestore first, unique local items appended
 *   5. If merged ≠ Firestore → write merged back
 *   6. Persist merged to memory + localStorage
 */

const CACHE_BASE   = 'hh_search_history';
const PENDING_BASE = 'hh_search_history_pending';
const MAX_ITEMS   = 5;
const MAX_LEN     = 120;   // per-query character limit
const DEBOUNCE_MS = 800;
const FS_FIELD    = 'recentSearches';
const FS_TS_FIELD = 'recentSearchesUpdatedAt';

// ── Pure helpers ──────────────────────────────────────────────────────────────

function normalize(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
}

function sanitize(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const out  = [];
    for (const raw of items) {
        const q = normalize(String(raw));
        if (!q || q.length > MAX_LEN) continue;
        const key = q.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(q); }
    }
    return out.slice(0, MAX_ITEMS);
}

// ── localStorage helpers ──────────────────────────────────────────────────────

// Instance-level scoped keys — set in init(uid) to isolate per user.
// Default to bare base keys as a safety fallback (should not normally be used).
let _cacheKey   = CACHE_BASE;
let _pendingKey = PENDING_BASE;

function readCache() {
    try {
        const raw = localStorage.getItem(_cacheKey);
        if (!raw) return [];
        return sanitize(JSON.parse(raw));
    } catch { return []; }
}

function writeCache(items) {
    try { localStorage.setItem(_cacheKey, JSON.stringify(items)); }
    catch { /* private-mode / storage-full — graceful no-op */ }
}

function clearCache() {
    try {
        localStorage.removeItem(_cacheKey);
        localStorage.removeItem(_pendingKey);
    } catch { /* ignore */ }
}

function readPending() {
    try {
        const raw = localStorage.getItem(_pendingKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed;
    } catch { return null; }
}

function writePending(items) {
    try { localStorage.setItem(_pendingKey, JSON.stringify({ items, ts: Date.now() })); }
    catch { /* ignore */ }
}

function clearPending() {
    try { localStorage.removeItem(_pendingKey); } catch { /* ignore */ }
}

/**
 * One-time migration from the two legacy keys used by the old dual-system.
 * Returns any items found, or []. After calling init() these keys stay in
 * localStorage until the browser clears them — they are never written again.
 */
function migrateFromLegacyKeys() {
    const legacyKeys = ['recentSearches', 'tracking_recent_searches_v1'];
    for (const key of legacyKeys) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return sanitize(parsed);
            }
        } catch { continue; }
    }
    return [];
}

// ── Service class ─────────────────────────────────────────────────────────────

class SearchHistoryService {

    constructor() {
        this._items         = [];
        this._uid           = null;
        this._repo          = null;   // customerRepository instance
        this._listeners     = [];
        this._debounceTimer = null;
        this._initialized   = false;
    }

    /**
     * Initialize for a given user. Resolves after Firestore hydration.
     * Safe to call multiple times — subsequent calls are no-ops.
     *
     * @param {string}  uid                Authenticated user UID
     * @param {object}  customerRepository Instance from getAppContainer()
     */
    async init(uid, customerRepository) {
        if (this._initialized && this._uid === uid) return;

        this._uid  = uid;
        this._repo = customerRepository;

        // Activate uid-scoped storage keys for this user
        _cacheKey   = CACHE_BASE   + '_' + uid;
        _pendingKey = PENDING_BASE + '_' + uid;

        // ── Step 1: Instant paint from cache (or migrate from legacy keys) ──
        let cached = readCache();
        if (cached.length === 0) {
            const migrated = migrateFromLegacyKeys();
            if (migrated.length > 0) {
                cached = migrated;
                writeCache(cached);   // promote to canonical key immediately
            }
        }
        this._items = cached;
        this._notify();

        // ── Step 2: Flush pending offline writes before loading remote ───────
        const pending = readPending();
        if (pending) {
            try {
                await this._writeToFirestore(pending.items);
                clearPending();
            } catch {
                // Will retry on next init() — leave pending in place
            }
        }

        // ── Step 3: Load from Firestore ──────────────────────────────────────
        try {
            const remote = await this._loadFromFirestore();

            // ── Step 4: Merge — Firestore wins ordering, local extras appended
            const merged = sanitize([...remote, ...this._items]);

            // ── Step 5: Write back if merged has more than remote ─────────────
            const needsSync =
                JSON.stringify(merged) !== JSON.stringify(sanitize(remote));

            if (needsSync && merged.length > 0) {
                this._writeToFirestore(merged).catch(() => { /* best-effort */ });
            }

            // ── Step 6: Persist merged ────────────────────────────────────────
            this._items = merged;
            writeCache(merged);
            this._notify();
        } catch (err) {
            console.warn('[SearchHistory] Firestore hydration failed — using cache:', err.message);
            // Stay on cached data. No disruption to the user.
        }

        this._initialized = true;
    }

    /**
     * Record a new search query. Call immediately when the user submits a search.
     * Resolves synchronously (UI updates at call site), Firestore write is async.
     *
     * @param {string} query
     */
    add(query) {
        const q = normalize(query);
        if (!q || q.length > MAX_LEN) return;

        const without = this._items.filter(i => i.toLowerCase() !== q.toLowerCase());
        this._items   = sanitize([q, ...without]);
        writeCache(this._items);
        this._notify();
        this._scheduleFirestoreWrite();
    }

    /**
     * Remove a single query. UI updates synchronously.
     *
     * @param {string} query
     */
    remove(query) {
        const lower = normalize(query).toLowerCase();
        if (!lower) return;
        this._items = this._items.filter(i => i.toLowerCase() !== lower);
        writeCache(this._items);
        this._notify();
        this._scheduleFirestoreWrite();
    }

    /**
     * Wipe all history for this user — local + Firestore.
     * Firestore write is immediate (not debounced) for a clear.
     */
    clear() {
        this._cancelDebounce();
        this._items = [];
        clearCache();
        this._notify();
        this._writeToFirestore([]).catch(err => {
            console.warn('[SearchHistory] Clear sync failed:', err.message);
        });
    }

    /** Returns a defensive copy of the current item list. */
    getAll() { return [...this._items]; }

    /**
     * Subscribe to item-list changes.
     * The callback is called immediately with the current state.
     *
     * @param {function(string[]): void} callback
     * @returns {function(): void}  Unsubscribe function
     */
    subscribe(callback) {
        if (typeof callback !== 'function') return () => {};
        this._listeners.push(callback);
        callback([...this._items]);   // immediate snapshot
        return () => {
            this._listeners = this._listeners.filter(l => l !== callback);
        };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _notify() {
        const snapshot = [...this._items];
        for (const cb of this._listeners) {
            try { cb(snapshot); }
            catch (e) { console.warn('[SearchHistory] Subscriber error:', e); }
        }
    }

    _scheduleFirestoreWrite() {
        this._cancelDebounce();
        const items = [...this._items];
        this._debounceTimer = setTimeout(async () => {
            this._debounceTimer = null;
            try {
                await this._writeToFirestore(items);
                clearPending();
            } catch (err) {
                console.warn('[SearchHistory] Sync failed, queuing for retry:', err.message);
                writePending(items);
            }
        }, DEBOUNCE_MS);
    }

    _cancelDebounce() {
        if (this._debounceTimer !== null) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
    }

    async _loadFromFirestore() {
        if (!this._repo || !this._uid) return [];
        const doc = await this._repo.getById(this._uid);
        if (!doc?.exists || !doc.data) return [];
        return sanitize(doc.data[FS_FIELD] || []);
    }

    async _writeToFirestore(items) {
        if (!this._repo || !this._uid) throw new Error('Service not initialized');
        await this._repo.updateSearchHistory(this._uid, sanitize(items));
    }
}

export { SearchHistoryService, normalize as normalizeSearchQuery, sanitize as sanitizeSearchHistory };
