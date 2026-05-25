/**
 * memoryCacheService.js
 *
 * Lightweight, synchronous, TTL-based in-memory cache.
 * Lives only for the current page lifetime — no persistence.
 *
 * Usage:
 *   const cache = createMemoryCache({ defaultTtlMs: 30_000 });
 *   cache.set('key', value);
 *   cache.get('key');       // undefined after TTL expires
 *   cache.delete('key');
 *   cache.deleteByPrefix('customers/');
 */

export function createMemoryCache({ defaultTtlMs = 30_000 } = {}) {
    // store: Map<key, { value, expiresAt }>
    const store = new Map();

    /**
     * Retrieve a value by key.
     * Returns `undefined` if the key is missing or its TTL has elapsed.
     */
    function get(key) {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    /**
     * Store a value with an optional per-entry TTL (ms).
     * Falls back to the defaultTtlMs passed to createMemoryCache().
     */
    function set(key, value, ttlMs) {
        store.set(key, {
            value,
            expiresAt: Date.now() + (ttlMs != null ? ttlMs : defaultTtlMs)
        });
    }

    /** Returns true if the key exists and hasn't expired. */
    function has(key) {
        const entry = store.get(key);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) { store.delete(key); return false; }
        return true;
    }

    /** Remove a single entry. */
    function del(key) {
        store.delete(key);
    }

    /**
     * Remove all entries whose key starts with `prefix`.
     * Useful for invalidating an entire collection's cached queries.
     */
    function deleteByPrefix(prefix) {
        for (const k of store.keys()) {
            if (k.startsWith(prefix)) store.delete(k);
        }
    }

    /** Wipe everything. */
    function clear() {
        store.clear();
    }

    /** Number of live entries (including not-yet-expired). */
    function size() {
        return store.size;
    }

    return { get, set, has, delete: del, deleteByPrefix, clear, size };
}
