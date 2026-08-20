'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HandyHub Service Worker
// Bump CACHE_VERSION when deploying new assets to force cache refresh.
// ─────────────────────────────────────────────────────────────────────────────

// v6 — Firebase SDK modules are now cached (see isFirebaseSdkAsset). Bumping
// forces the new worker to activate and retires the v5 cache.
const CACHE_VERSION = 'handyhub-v6';

// Static assets to pre-cache on install
const PRECACHE_ASSETS = [
    '/customer-app/',
    '/customer-app/index.html',
    '/customer-app/login.html',
    '/customer-app/signup.html',
    '/customer-app/dashboard.html',
];

// Hostnames whose requests must bypass the cache entirely
// (Firebase, Paystack, font CDNs, image CDNs, reverse-geocode APIs, etc.)
const BYPASS_HOSTS = [
    'firebaseio.com',
    'firebaseapp.com',
    'googleapis.com',
    'gstatic.com',
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'cloudfunctions.net',
    'paystack.co',
    'js.paystack.co',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'res.cloudinary.com',
    'nominatim.openstreetmap.org',
    'ui-avatars.com',
    'bigdatacloud.net',
];

/**
 * True only for immutable, version-pinned Firebase SDK library files.
 *
 * Matches:  https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js
 * Rejects:  firestore.googleapis.com  (live data — must never be cached)
 *           fonts.gstatic.com         (handled by the normal asset path)
 *
 * The /firebasejs/<version>/ segment is what makes this safe: the version is in
 * the URL, so new SDK releases are simply different URLs and cannot be served
 * stale from cache.
 */
function isFirebaseSdkAsset(url) {
    return url.hostname === 'www.gstatic.com'
        && /^\/firebasejs\/\d+\.\d+\.\d+\//.test(url.pathname);
}

// ─────────────────────────────────────────────────────────────────────────────
// Install — pre-cache key shell assets
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(PRECACHE_ASSETS))
            .then(() => self.skipWaiting())
            .catch((err) => console.warn('[SW] Pre-cache failed (non-fatal):', err))
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// Activate — delete stale caches from previous versions
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((k) => k !== CACHE_VERSION)
                        .map((k) => caches.delete(k))
                )
            )
            .then(() => self.clients.claim())
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch — intercept requests
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only handle GET requests
    if (request.method !== 'GET') return;

    // Skip non-http(s) schemes (chrome-extension, data:, etc.)
    if (!request.url.startsWith('http')) return;

    const url = new URL(request.url);

    // ── Firebase SDK modules — cache-first, ahead of the bypass below ────────
    //
    // This app is multi-page: every navigation is a full document load, and each
    // one re-downloads 5 Firebase SDK modules from www.gstatic.com. That network
    // cost is paid on EVERY navigation and is a large part of why returning to a
    // screen feels slow — no amount of data caching removes it.
    //
    // Safe to cache aggressively because the version is pinned in the path
    // (/firebasejs/10.8.0/firebase-app.js). These bytes are immutable: upgrading
    // the SDK changes the URL, which is a cache miss, which fetches fresh. That
    // is exactly the property cache-first requires.
    //
    // Deliberately placed BEFORE the BYPASS_HOSTS check — 'gstatic.com' is in
    // that list, which is correct for live-data origins but was also, silently,
    // preventing the SDK from ever being cached.
    if (isFirebaseSdkAsset(url)) {
        event.respondWith(cacheFirst(request));
        return;
    }

    // Bypass live-data origins — never cache Firebase, Paystack, CDN assets, etc.
    if (BYPASS_HOSTS.some((host) => url.hostname.endsWith(host))) return;

    // HTML pages → network-first (keep content fresh; fall back to cache offline)
    const acceptsHtml = request.headers.get('accept')?.includes('text/html');
    if (acceptsHtml) {
        event.respondWith(networkFirst(request));
        return;
    }

    // Everything else (CSS, JS, images, fonts served from same origin) → cache-first
    // App scripts and styles use stable (unhashed) URLs, so cache-first can
    // mix module versions after a deploy. Fetch code from the network first;
    // retain the cached response only as an offline fallback.
    if (url.origin === self.location.origin &&
        (request.destination === 'script' || request.destination === 'style')) {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});

// ─────────────────────────────────────────────────────────────────────────────
// Caching strategies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache-first: serve from cache immediately; fetch & update cache in background.
 * Best for versioned static assets (CSS, JS, images).
 */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        return await fetchAndCache(request);
    } catch (_) {
        // Network unavailable and no cache hit — return a typed network-error
        // response so event.respondWith() resolves instead of rejecting (which
        // would flood the console with unhandled-promise-rejection warnings).
        return Response.error();
    }
}

/**
 * Network-first: try the network; fall back to cache when offline.
 * Best for HTML pages that change with each deploy.
 */
async function networkFirst(request) {
    try {
        return await fetchAndCache(request);
    } catch (_) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(
            '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">' +
            '<h2>You\'re offline</h2><p>Please check your connection and try again.</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html' } }
        );
    }
}

/**
 * Fetch from network, store a copy in cache, and return the response.
 *
 * ✅ FIX: response.clone() is called BEFORE the response body is consumed.
 *    Calling clone() after reading the body (e.g. after cache.put or response.json())
 *    throws "Failed to execute 'clone' on 'Response': Response body is already used".
 */
async function fetchAndCache(request) {
    const response = await fetch(request);

    // Only cache valid, same-origin (non-opaque) successful responses
    if (!response || !response.ok || response.type === 'opaque') {
        return response;
    }

    // ✅ Clone BEFORE consuming — the clone goes to the cache, the original is
    //    returned to the browser. Both share the same underlying stream until
    //    one side reads it, so cloning first guarantees both are usable.
    const responseToCache = response.clone();

    caches.open(CACHE_VERSION)
        .then((cache) => cache.put(request, responseToCache))
        .catch((err) => console.warn('[SW] Cache write failed:', err));

    return response;
}
