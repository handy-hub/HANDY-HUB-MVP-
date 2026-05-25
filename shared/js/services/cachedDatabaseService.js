/**
 * cachedDatabaseService.js
 *
 * Transparent in-memory cache wrapper around any databaseService implementation.
 * Drop it in between the DI container and the raw Firebase service — all
 * repositories and pages benefit with zero changes to consumer code.
 *
 * Strategy per operation type
 * ───────────────────────────
 * One-shot reads   (getDocument, queryWithOptions, queryByField, querySubCollection)
 *   → Check cache first; hit = return immediately, miss = fetch + populate cache.
 *
 * Writes           (setDocument, updateDocument, deleteDocument, addDocument, …)
 *   → Invalidate the affected doc key and all query keys for the same collection
 *     before/after the write, so the next read always sees fresh data.
 *
 * Real-time subs   (subscribeToDocument, subscribeToCollection, …)
 *   → Pass through to Firestore unchanged, but warm the cache on every snapshot
 *     so any subsequent one-shot read for the same doc is served from memory.
 *
 * Per-collection TTLs (ms)
 * ────────────────────────
 *   customers              60 000   (profile data — rare changes)
 *   artisans              120 000   (artisan listings — very stable)
 *   bookings               30 000   (status can change frequently)
 *   customer_notifications  15 000  (time-sensitive)
 *   payment_accounts        45 000
 *   default                 30 000
 */

import { createMemoryCache } from './memoryCacheService.js';

// ── Per-collection TTLs ────────────────────────────────────────────────────────
const COLLECTION_TTL = {
    customers:              60_000,
    artisans:              120_000,
    bookings:               30_000,
    customer_notifications: 15_000,
    payment_accounts:       45_000
};
const DEFAULT_TTL = 30_000;

function ttlFor(collectionName) {
    return COLLECTION_TTL[collectionName] ?? DEFAULT_TTL;
}

// ── Cache-key helpers ──────────────────────────────────────────────────────────

/** Key for a single document. */
function docKey(col, id) {
    return `doc:${col}/${id}`;
}

/**
 * Key for a query result set.
 * Falls back to a non-cacheable sentinel if conditions/options aren't serialisable.
 */
function queryKey(namespace, conditions, options) {
    try {
        return `q:${namespace}:${JSON.stringify(conditions)}:${JSON.stringify(options ?? {})}`;
    } catch {
        return `__nocache__${Math.random()}`; // non-serialisable → skip cache
    }
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createCachedDatabaseService(databaseService, { defaultTtlMs = DEFAULT_TTL } = {}) {
    const cache = createMemoryCache({ defaultTtlMs });

    // ── One-shot reads ───────────────────────────────────────────────────────

    async function getDocument(collectionName, documentId) {
        const key = docKey(collectionName, documentId);
        const hit = cache.get(key);
        if (hit !== undefined) return hit;

        const result = await databaseService.getDocument(collectionName, documentId);
        cache.set(key, result, ttlFor(collectionName));
        return result;
    }

    async function queryByField(collectionName, fieldName, operator, value) {
        const key = queryKey(collectionName, [{ fieldName, operator, value }], {});
        const hit = cache.get(key);
        if (hit !== undefined) return hit;

        const result = await databaseService.queryByField(collectionName, fieldName, operator, value);
        cache.set(key, result, ttlFor(collectionName));
        return result;
    }

    async function queryWithOptions(collectionName, conditions = [], options = {}) {
        const key = queryKey(collectionName, conditions, options);
        const hit = cache.get(key);
        if (hit !== undefined) return hit;

        const result = await databaseService.queryWithOptions(collectionName, conditions, options);
        cache.set(key, result, ttlFor(collectionName));
        return result;
    }

    async function querySubCollection(collectionName, documentId, subCollectionName, conditions = [], options = {}) {
        const ns  = `${collectionName}/${documentId}/${subCollectionName}`;
        const key = queryKey(ns, conditions, options);
        const hit = cache.get(key);
        if (hit !== undefined) return hit;

        const result = await databaseService.querySubCollection(
            collectionName, documentId, subCollectionName, conditions, options
        );
        cache.set(key, result, ttlFor(subCollectionName));
        return result;
    }

    // ── Writes — invalidate before returning ─────────────────────────────────

    async function setDocument(collectionName, documentId, data, options = {}) {
        cache.delete(docKey(collectionName, documentId));
        cache.deleteByPrefix(`q:${collectionName}:`);
        return databaseService.setDocument(collectionName, documentId, data, options);
    }

    async function updateDocument(collectionName, documentId, data) {
        cache.delete(docKey(collectionName, documentId));
        cache.deleteByPrefix(`q:${collectionName}:`);
        return databaseService.updateDocument(collectionName, documentId, data);
    }

    async function deleteDocument(collectionName, documentId) {
        cache.delete(docKey(collectionName, documentId));
        cache.deleteByPrefix(`q:${collectionName}:`);
        return databaseService.deleteDocument(collectionName, documentId);
    }

    async function addDocument(collectionName, data) {
        // New document invalidates all queries on the collection
        cache.deleteByPrefix(`q:${collectionName}:`);
        return databaseService.addDocument(collectionName, data);
    }

    async function addSubDocument(collectionName, documentId, subCollectionName, data) {
        cache.deleteByPrefix(`q:${collectionName}/${documentId}/${subCollectionName}:`);
        return databaseService.addSubDocument(collectionName, documentId, subCollectionName, data);
    }

    async function updateSubDocument(collectionName, documentId, subCollectionName, subDocumentId, data) {
        cache.deleteByPrefix(`q:${collectionName}/${documentId}/${subCollectionName}:`);
        return databaseService.updateSubDocument(
            collectionName, documentId, subCollectionName, subDocumentId, data
        );
    }

    // ── Real-time subscriptions — pass through + warm cache ──────────────────

    function subscribeToDocument(collectionName, docId, onChange, onError) {
        return databaseService.subscribeToDocument(collectionName, docId, (snap) => {
            // Subscription is always the freshest source — keep cache warm
            cache.set(docKey(collectionName, docId), snap, ttlFor(collectionName));
            onChange(snap);
        }, onError);
    }

    function subscribeToCollection(collectionName, conditions, options, onChange, onError) {
        return databaseService.subscribeToCollection(collectionName, conditions, options, (records) => {
            // Warm individual doc entries so getDocument() is instant afterwards
            const ttl = ttlFor(collectionName);
            records.forEach(r => {
                cache.set(
                    docKey(collectionName, r.id),
                    { id: r.id, exists: true, data: r.data },
                    ttl
                );
            });
            onChange(records);
        }, onError);
    }

    function subscribeToSubCollection(collectionName, documentId, subCollectionName, conditions, options, onChange, onError) {
        return databaseService.subscribeToSubCollection(
            collectionName, documentId, subCollectionName,
            conditions, options, onChange, onError
        );
    }

    // ── Pass-through ─────────────────────────────────────────────────────────

    function getMetadata() {
        return databaseService.getMetadata();
    }

    // ── Manual cache controls (for advanced use-cases) ────────────────────────

    function invalidate(collectionName, documentId) {
        cache.delete(docKey(collectionName, documentId));
    }

    function invalidateCollection(collectionName) {
        cache.deleteByPrefix(`doc:${collectionName}/`);
        cache.deleteByPrefix(`q:${collectionName}:`);
    }

    function clearCache() {
        cache.clear();
    }

    // ── Public interface ─────────────────────────────────────────────────────

    return {
        // Reads
        getDocument,
        queryByField,
        queryWithOptions,
        querySubCollection,

        // Writes
        setDocument,
        updateDocument,
        deleteDocument,
        addDocument,
        addSubDocument,
        updateSubDocument,

        // Subscriptions
        subscribeToDocument,
        subscribeToCollection,
        subscribeToSubCollection,

        // Misc
        getMetadata,

        // Cache management
        invalidate,
        invalidateCollection,
        clearCache
    };
}
