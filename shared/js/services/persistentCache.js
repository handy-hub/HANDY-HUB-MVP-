/**
 * persistentCache.js — one small, versioned, TTL'd cache that SURVIVES navigation.
 * ─────────────────────────────────────────────────────────────────────────────
 * The customer app is a multi-page app: a fresh document loads on every
 * navigation, which wipes ALL in-memory state (including the cachedDatabaseService
 * memory cache, which self-documents as "lives only for the current page
 * lifetime"). So sections that want to survive a navigate-away-and-back without
 * re-shimmering and re-reading Firestore need a store that outlives the document.
 *
 * This is the canonical home for that pattern. Several sections already hand-roll
 * it (nearbyPros.js artisan-pool cache, the dashboard profile/location paint,
 * HH_State.profile) — new consumers should use THIS instead of inventing another
 * key format, and the existing ones can migrate onto it over time.
 *
 * Use it ONLY for slowly-changing, non-sensitive PRESENTATION data
 * (promotions, categories, static config). NEVER for financial / booking /
 * security-sensitive state (wallet, payment, escrow, live status) — those must
 * use real-time subscriptions, not a cache.
 *
 * Contract
 * ────────
 *   readCache(key, { uid, version, ttlMs, storage }) → { data, ageMs } | null
 *   writeCache(key, data, { uid, version, storage })  → boolean
 *   invalidateCache(key, { uid, storage })            → void
 *
 * A read returns null (miss) when the entry is: absent, unparseable, a different
 * schema `version`, a different `uid`, or older than `ttlMs`. Callers use the
 * returned `ageMs` to implement stale-while-revalidate (paint now, and decide
 * whether to revalidate based on how old the cache is).
 *
 * Envelope stored as JSON: { v: version, t: writtenAt, u: uid|null, d: data }.
 */

const PREFIX = 'hh_pc_';

/** Resolve the requested Web Storage area, or null if unavailable (SSR / private
 *  mode / blocked). Reads globalThis so the module is unit-testable under Node. */
function store(kind) {
  try {
    const w = (typeof window !== 'undefined') ? window : globalThis.window;
    if (!w) return null;
    return kind === 'session' ? w.sessionStorage : w.localStorage;
  } catch {
    return null;
  }
}

function fullKey(key, uid) {
  return PREFIX + key + (uid ? '_' + uid : '');
}

/**
 * Read a cached value.
 * @returns {{ data: any, ageMs: number } | null} null on any miss/mismatch/expiry.
 */
export function readCache(key, { uid = null, version = 1, ttlMs = Infinity, storage = 'local' } = {}) {
  const s = store(storage);
  if (!s) return null;

  let env;
  try {
    env = JSON.parse(s.getItem(fullKey(key, uid)) || 'null');
  } catch {
    return null;                                   // unparseable → treat as miss
  }
  if (!env || typeof env !== 'object') return null;
  if (env.v !== version) return null;              // schema changed → discard
  if ((env.u ?? null) !== (uid ?? null)) return null; // wrong user → discard

  const ageMs = Date.now() - (env.t || 0);
  if (ageMs > ttlMs) return null;                  // expired
  return { data: env.d, ageMs };
}

/**
 * Write a cached value. Never throws (quota / private mode → returns false).
 */
export function writeCache(key, data, { uid = null, version = 1, storage = 'local' } = {}) {
  const s = store(storage);
  if (!s) return false;
  try {
    s.setItem(fullKey(key, uid), JSON.stringify({ v: version, t: Date.now(), u: uid ?? null, d: data }));
    return true;
  } catch {
    return false;                                  // quota exceeded / blocked
  }
}

/** Remove a single cached entry. */
export function invalidateCache(key, { uid = null, storage = 'local' } = {}) {
  const s = store(storage);
  if (!s) return;
  try { s.removeItem(fullKey(key, uid)); } catch { /* non-fatal */ }
}
