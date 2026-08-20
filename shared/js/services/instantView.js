/**
 * instantView.js — the one way HandyHub screens load data.
 *
 * THE LAW: RENDER FIRST. FETCH SECOND. NEVER BLOCK THE USER UNNECESSARILY.
 *
 * HandyHub is a multi-page app: every navigation is a full browser document
 * load that destroys the JS heap, all listeners and all in-memory state. There
 * is no component tree to keep mounted, so "don't remount the screen" is not
 * available to us. What IS available — and what this module exists to make
 * effortless — is:
 *
 *     paint from a navigation-surviving cache BEFORE the network is consulted,
 *     then reconcile silently when live data arrives.
 *
 * WHY A SHARED MODULE RATHER THAN A DOCUMENTED PATTERN
 * Two real bugs shipped because the pattern was reimplemented per screen:
 *   • The promo banner cached with a 10-minute TTL, so any visit more than ten
 *     minutes later fell to the cold path and shimmered. The TTL had been
 *     conflated with the freshness window.
 *   • The notification list read its cache under a bare key but wrote it under a
 *     uid-scoped one, because the uid is only known after auth resolves. The two
 *     never matched, so a perfectly good cache was never once read.
 * Both looked correct in review and failed silently in production. Centralising
 * the mechanics removes the opportunity to get them wrong again.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   import { mountInstantView } from '../../shared/js/services/instantView.js';
 *
 *   const view = mountInstantView({
 *     key:      'saved-artisans',
 *     version:  1,
 *     staleMs:  60_000,            // refresh in the background past this age
 *     render:   (items) => renderList(items),
 *     onEmpty:  () => showSkeleton(),
 *     subscribe: (uid, onData, onError) =>
 *       repo.subscribeToSaved(uid, onData, onError),
 *   });
 *   window.addEventListener('pagehide', () => view.destroy());
 *
 * ── The rules this encodes ──────────────────────────────────────────────────
 *   1. uid is resolved SYNCHRONOUSLY, before the first read, so the read key
 *      and the write key can never disagree.
 *   2. A cache hit paints immediately. A miss — and only a miss — shows the
 *      skeleton. Existing content is never replaced by a spinner.
 *   3. `version` invalidates payloads whose shape has changed, so a renderer
 *      never receives a half-populated object from an older release.
 *   4. `ttlMs` (paintable) and `staleMs` (fresh) are SEPARATE. Default ttlMs is
 *      a full day: painting slightly old content for one frame is almost always
 *      better than a skeleton, because the live listener corrects it in moments.
 *   5. An account switch clears the painted content rather than leaving one
 *      user's data on screen under another's session.
 *   6. A failed refresh NEVER blanks good cached content — it is reported only
 *      when there is nothing on screen to keep.
 *
 * ── What must NOT go through here ───────────────────────────────────────────
 * Money. Wallet balances, escrow state, payment status and booking
 * authorisation are backend-authoritative. Cached figures may be shown for
 * visual continuity, but no financial decision may be taken from them, and
 * `stripFields` exists so screens can keep money out of the cache entirely.
 */

import { readCache, writeCache, invalidateCache } from './persistentCache.js';

/** One day. The cache governs the FIRST PAINT only; the listener owns truth. */
const DEFAULT_TTL_MS   = 24 * 60 * 60 * 1000;
/** Past this age we revalidate in the background. Painting still happens first. */
const DEFAULT_STALE_MS = 60 * 1000;

/**
 * Resolve the signed-in uid WITHOUT awaiting Firebase Auth.
 *
 * Auth restoration is asynchronous, but the first paint must not wait for it.
 * `hh_last_session_uid` is written by HH_State.setUser() on every authenticated
 * page load, so it is available synchronously on any return visit. Returns null
 * on a first-ever load, which correctly yields an unscoped key and a cache miss.
 */
export function resolveSessionUid() {
    try {
        const w = (typeof window !== 'undefined') ? window : globalThis.window;
        if (w?.HH_State?.currentUid?.()) return w.HH_State.currentUid();
        return w?.localStorage?.getItem('hh_last_session_uid') || null;
    } catch {
        return null;   // storage blocked (private mode) — degrade to a cold load
    }
}

/**
 * Mount a screen section that paints from cache and revalidates in the
 * background.
 *
 * @param {object}   o
 * @param {string}   o.key            Cache key, unique per screen section.
 * @param {number}   [o.version=1]    Bump when the cached shape changes.
 * @param {number}   [o.ttlMs]        How long a payload stays paintable.
 * @param {number}   [o.staleMs]      How long a payload stays fresh.
 * @param {Function} o.render         (data, { fromCache }) => void
 * @param {Function} [o.onEmpty]      Called only on a genuine cache miss.
 * @param {Function} [o.subscribe]    (uid, onData, onError) => unsubscribe
 * @param {Function} [o.fetch]        (uid) => Promise<data>. Used when there is
 *                                    no subscribe, or to revalidate a stale hit.
 * @param {Function} [o.onError]      (err, { hasContent }) => void
 * @param {string[]} [o.stripFields]  Keys removed before caching (money, tokens).
 * @param {boolean}  [o.cacheEmpty=true] Cache an empty result, so "genuinely
 *                                    nothing" paints instantly too instead of
 *                                    re-showing a skeleton on every visit.
 * @returns {{ destroy: Function, refresh: Function, invalidate: Function, paintedFromCache: boolean }}
 */
export function mountInstantView({
    key,
    version = 1,
    ttlMs   = DEFAULT_TTL_MS,
    staleMs = DEFAULT_STALE_MS,
    render,
    onEmpty,
    subscribe,
    fetch: fetchFn,
    onError,
    stripFields = [],
    cacheEmpty = true,
}) {
    if (!key || typeof render !== 'function') {
        throw new Error('mountInstantView: `key` and `render` are required.');
    }

    const uid = resolveSessionUid();
    const opts = { uid, version, storage: 'local' };

    let unsubscribe   = null;
    let destroyed     = false;
    let hasContent    = false;
    let paintedFromCache = false;

    // ── 1. Paint from cache, before any network work ────────────────────────
    let cachedAgeMs = Infinity;
    try {
        const hit = readCache(key, { ...opts, ttlMs });
        if (hit && hit.data !== undefined && hit.data !== null) {
            render(hit.data, { fromCache: true });
            hasContent = true;
            paintedFromCache = true;
            cachedAgeMs = hit.ageMs;
        }
    } catch (err) {
        // A cache fault must never prevent the real load.
        console.warn(`[instantView:${key}] cache read failed:`, err?.message || err);
    }

    // Only a genuine miss earns a skeleton. Existing content is never replaced.
    if (!hasContent && typeof onEmpty === 'function') onEmpty();

    // ── 2. Persist whatever the live source reports ─────────────────────────
    const persist = (data) => {
        if (data == null) return;
        if (!cacheEmpty && Array.isArray(data) && data.length === 0) return;
        let payload = data;
        if (stripFields.length && !Array.isArray(data) && typeof data === 'object') {
            payload = { ...data };
            for (const f of stripFields) delete payload[f];
        }
        try { writeCache(key, payload, opts); }
        catch (err) { console.warn(`[instantView:${key}] cache write failed:`, err?.message || err); }
    };

    const handleData = (data) => {
        if (destroyed) return;
        render(data, { fromCache: false });
        hasContent = true;
        persist(data);
    };

    const handleError = (err) => {
        if (destroyed) return;
        console.warn(`[instantView:${key}] refresh failed:`, err?.message || err);
        // Cached content stays on screen. A transient network fault is not a
        // reason to blank a screen the customer is already reading.
        if (typeof onError === 'function') onError(err, { hasContent });
    };

    // ── 3. Revalidate ───────────────────────────────────────────────────────
    if (typeof subscribe === 'function') {
        // Realtime screens always subscribe: the listener IS the refresh, and
        // it also keeps the screen live while the customer sits on it.
        try {
            unsubscribe = subscribe(uid, handleData, handleError);
        } catch (err) {
            handleError(err);
        }
    } else if (typeof fetchFn === 'function') {
        // One-shot screens: skip the network entirely while the cache is fresh.
        const needsFetch = !paintedFromCache || cachedAgeMs >= staleMs;
        if (needsFetch) {
            Promise.resolve()
                .then(() => fetchFn(uid))
                .then(handleData)
                .catch(handleError);
        }
    }

    return {
        /** Force a refresh (pull-to-refresh, or after a mutation elsewhere). */
        refresh() {
            if (destroyed || typeof fetchFn !== 'function') return Promise.resolve();
            return Promise.resolve()
                .then(() => fetchFn(uid))
                .then(handleData)
                .catch(handleError);
        },
        /** Drop the cached payload — call after a mutation invalidates it. */
        invalidate() {
            try { invalidateCache(key, opts); } catch { /* non-fatal */ }
        },
        /** Always call on pagehide so listeners do not outlive the document. */
        destroy() {
            destroyed = true;
            if (typeof unsubscribe === 'function') {
                try { unsubscribe(); } catch { /* already gone */ }
            }
            unsubscribe = null;
        },
        get paintedFromCache() { return paintedFromCache; },
    };
}

/**
 * Guard against painting one account's data into another's session.
 *
 * Call once the authoritative uid is known. If it differs from the uid the
 * early paint used, the painted content came from the wrong key and must go.
 *
 * @returns {boolean} true when the early paint was stale and was discarded.
 */
export function reconcileSessionUid(paintedUid, authoritativeUid, onMismatch) {
    if (paintedUid === authoritativeUid) return false;
    if (typeof onMismatch === 'function') onMismatch();
    return true;
}
