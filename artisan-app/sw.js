'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Fidus X Artisan — app-shell service worker (AR-16, 2026-10-20)
//
// Scope: /artisan-app/ only. Push belongs to a DIFFERENT registration —
// /firebase-messaging-sw.js at scope '/', registered by
// shared/js/services/pushNotificationService.js — so this worker has no push or
// notificationclick handlers and never touches that file.
//
// WHAT IS CACHED, AND WHY SO LITTLE
// The artisan app handles customers' addresses and phone numbers (once a job
// is accepted), payouts and identity documents. None of that is fetched from
// this origin: it comes from Firestore, Cloud Functions, Firebase Auth,
// Paystack and Cloudinary, which are CROSS-ORIGIN and therefore always go
// straight to the network here. On this origin:
//   • pages (navigations)     network only; if offline, a static "you're
//                             offline" page. Pages are never cached, so an
//                             old page can never resurrect an old sign-in or
//                             redirect state.
//   • scripts and styles      network first; the cached copy is used only when
//                             offline. Serving a cached script with a freshly
//                             fetched page would mix two releases.
//   • images and fonts        stale-while-revalidate (they carry no user data).
//   • everything else, every non-GET, anything with an Authorization header,
//     Firebase Hosting's reserved /__/ paths (the Auth popup handler), the
//     messaging worker and the release manifest: network only, untouched.
// Firebase's own offline data cache (IndexedDB) is separate and unchanged.
//
// Bump VERSION when the offline page changes; activation deletes old caches.
// ─────────────────────────────────────────────────────────────────────────────

const VERSION      = 'fx-artisan-v2';
const SCOPE_PATH   = '/artisan-app/';
const OFFLINE_URL  = '/artisan-app/offline.html';
const NEVER_PATHS  = ['/firebase-messaging-sw.js', '/release-manifest.json', '/artisan-app/sw.js'];
const SCRIPT_RE    = /\.(?:js|mjs|css)$/i;
const MEDIA_RE     = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i;

/**
 * What to do with a request: 'network' | 'navigate' | 'network-first' | 'swr'.
 * Pure — tests call it through self.__fxArtisanSwPolicy.
 */
function policyFor({ url, method = 'GET', mode = '', destination = '', hasAuthorization = false, origin }) {
    const u = new URL(url);
    if (method !== 'GET' || hasAuthorization) return 'network';
    if (u.origin !== origin) return 'network';
    if (u.pathname.startsWith('/__/') || NEVER_PATHS.includes(u.pathname)) return 'network';
    if (mode === 'navigate' || destination === 'document') {
        return u.pathname.startsWith(SCOPE_PATH) ? 'navigate' : 'network';
    }
    if (u.search && /[?&](token|key|auth)=/i.test(u.search)) return 'network';
    if (!u.pathname.startsWith(SCOPE_PATH) && !u.pathname.startsWith('/shared/')) return 'network';
    if (SCRIPT_RE.test(u.pathname)) return 'network-first';
    if (MEDIA_RE.test(u.pathname))  return 'swr';
    return 'network';
}
self.__fxArtisanSwPolicy = policyFor;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSION)
            .then((cache) => cache.add(OFFLINE_URL))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())   // offline page missing: still activate; navigations then fail normally
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => k.startsWith('fx-artisan-') && k !== VERSION)
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function networkFirst(request) {
    const cache = await caches.open(VERSION);
    try {
        const res = await fetch(request);
        if (res && res.ok && res.type === 'basic') cache.put(request, res.clone());
        return res;
    } catch (err) {
        const hit = await cache.match(request);
        if (hit) return hit;
        throw err;
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request);
    const refresh = fetch(request)
        .then((res) => { if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()); return res; })
        .catch(() => null);
    return hit || (await refresh) || Response.error();
}

async function navigate(request) {
    try {
        return await fetch(request);
    } catch (err) {
        const offline = await caches.match(OFFLINE_URL);
        if (offline) return offline;
        throw err;
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const policy = policyFor({
        url: req.url, method: req.method, mode: req.mode, destination: req.destination,
        hasAuthorization: req.headers.has('Authorization'), origin: self.location.origin,
    });
    if (policy === 'network') return;   // the browser handles it exactly as without a worker
    if (policy === 'navigate')      event.respondWith(navigate(req));
    if (policy === 'network-first') event.respondWith(networkFirst(req));
    if (policy === 'swr')           event.respondWith(staleWhileRevalidate(req));
});
