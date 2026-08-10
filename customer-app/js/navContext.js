/* ============================================================================
 * HandyHub — Centralized Navigation Contract  (window.HH_Nav)
 * ----------------------------------------------------------------------------
 * ONE navigation system for the whole Customer App. No page may implement its
 * own back-navigation logic. Every back button, workflow exit, notification
 * entry, deep link, and auth redirect resolves through here.
 *
 * NAVIGATION TRUST PRINCIPLE
 *   Navigation must preserve the customer's ACTUAL journey, never assume a
 *   fixed "default" parent. A page must know where the user came from, and
 *   return them there whenever that origin is known and trusted.
 *
 * RESOLUTION ORDER for back() (mandated contract):
 *   1. Explicit validated navigation context from the current journey  (?from= URL id)
 *   2. Validated browser history state                                 (history.back, in-app + same-host)
 *   3. Validated session-scoped journey stack                          (sessionStorage breadcrumb)
 *   4. Safe page-specific fallback                                     (declared, allowlisted)
 *
 * SECURITY
 *   - `from` is a ROUTE IDENTIFIER (e.g. "professionals"), never a raw URL.
 *     It is validated against the ROUTES allowlist below, so an attacker cannot
 *     smuggle `?from=https://evil.com` (open redirect) — unknown ids are ignored.
 *   - goHref() only accepts same-origin relative "*.html" targets.
 *   - The journey stack is deduped and length-capped; loops are collapsed.
 *
 * This file is a classic script (no imports) so ANY page — module or not,
 * inline onclick or not — can use `HH_Nav.*`. Load it in <head> right after
 * themeManager.js, before page scripts.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---- Route registry / allowlist -----------------------------------------
   * key   = route identifier used in ?from= and go() (basename without .html)
   * file  = key + '.html' (implicit)
   * fallback = safe last-resort back target id (null for hubs with no parent)
   * single = true when the page has EXACTLY ONE guaranteed entry point, so a
   *          hardcoded parent is legitimate per the Navigation Trust Principle.
   * -------------------------------------------------------------------------*/
  var ROUTES = {
    // Hubs / top-level
    'dashboard':               { fallback: null,          single: false },
    'profile':                 { fallback: 'dashboard',   single: false },
    'settings':                { fallback: 'profile',     single: true  },
    'messages':                { fallback: 'dashboard',   single: false },
    'notification':            { fallback: 'dashboard',   single: false },
    'saved':                   { fallback: 'dashboard',   single: false },

    // Discovery
    'services':                { fallback: 'dashboard',   single: false },
    'professionals':           { fallback: 'dashboard',   single: false },
    'artisan-profile':         { fallback: 'professionals', single: false },
    'search-page':             { fallback: 'dashboard',   single: false },
    'search-not-found':        { fallback: 'search-page', single: false },

    // Booking lifecycle
    'book-request':            { fallback: 'dashboard',   single: false },
    'book-emergency':          { fallback: 'dashboard',   single: false },
    'booking':                 { fallback: 'dashboard',   single: false },
    'quote-approval':          { fallback: 'booking',     single: false },
    'live-tracking':           { fallback: 'booking',     single: false },
    'review':                  { fallback: 'booking',     single: false },

    // Wallet
    'topup':                   { fallback: 'profile',     single: false },
    'transaction-history':     { fallback: 'profile',     single: false },

    // Settings sub-pages — single guaranteed parent (settings), so a fixed
    // fallback is legitimate. They still resolve THROUGH the contract.
    'settings-personal-info':  { fallback: 'settings',    single: true },
    'settings-notifications':  { fallback: 'settings',    single: false }, // also reachable from notification
    'settings-security':       { fallback: 'settings',    single: true },
    'settings-location':       { fallback: 'settings',    single: true },
    'settings-privacy':        { fallback: 'settings',    single: true },
    'settings-privacy-policy': { fallback: 'settings',    single: true },
    'settings-terms':          { fallback: 'settings',    single: true },
    'settings-about':          { fallback: 'settings',    single: true },
    'settings-help':           { fallback: 'settings',    single: true }
  };

  var STACK_KEY = 'hh_nav_stack';
  var STACK_CAP = 20;

  /* ---- Low-level helpers ---------------------------------------------------*/

  function isKnown(id) { return !!(id && Object.prototype.hasOwnProperty.call(ROUTES, id)); }

  function fileOf(id) { return id + '.html'; }

  // Basename (no query/hash, no .html) of the current document.
  function currentId() {
    var base = (location.pathname.split('/').pop() || '').replace(/\.html?$/i, '');
    if (!base) base = 'dashboard';
    return isKnown(base) ? base : base; // return raw base even if unknown (used only for compare)
  }

  // Validated `?from=` route id, or null.
  function fromParam() {
    var raw;
    try { raw = new URLSearchParams(location.search).get('from'); } catch (_) { raw = null; }
    return isKnown(raw) ? raw : null;
  }

  // Same-origin relative "*.html[?...]" only — blocks open redirects.
  function isSafeHref(href) {
    return typeof href === 'string' &&
      /^[a-z0-9][a-z0-9._-]*\.html(\?[^#]*)?(#.*)?$/i.test(href) &&
      href.indexOf('//') === -1 && href.indexOf(':') === -1;
  }

  function readStack() {
    try { var a = JSON.parse(sessionStorage.getItem(STACK_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  }

  function writeStack(a) {
    try { sessionStorage.setItem(STACK_KEY, JSON.stringify(a.slice(-STACK_CAP))); } catch (_) {}
  }

  // Current page's relative URL (path basename + query), used for exact restore.
  function currentUrl() {
    var base = (location.pathname.split('/').pop()) || (currentId() + '.html');
    return base + (location.search || '');
  }

  /* ---- Journey stack management -------------------------------------------
   * The stack is a breadcrumb of {id, url} entries. On each page load init()
   * reconciles it: it collapses loops (revisiting a page truncates back to it),
   * folds in the ?from origin if the stack doesn't already reflect it, and
   * pushes the current page. This keeps the stack a faithful, loop-free record
   * of the real journey within the tab session.
   * -------------------------------------------------------------------------*/
  function reconcileStack() {
    var id = currentId();
    var from = fromParam();
    var stack = readStack();

    // Collapse loops: if we've returned to a page already in the stack, drop it
    // and everything after it (we're re-entering that point of the journey).
    var existingIdx = -1;
    for (var i = 0; i < stack.length; i++) { if (stack[i] && stack[i].id === id) { existingIdx = i; break; } }
    if (existingIdx !== -1) stack = stack.slice(0, existingIdx);

    // Ensure the trusted origin (?from=) is represented as the entry before us.
    if (from && from !== id) {
      var last = stack[stack.length - 1];
      if (!last || last.id !== from) stack.push({ id: from, url: fileOf(from) });
    }

    // Push the current page.
    stack.push({ id: id, url: currentUrl() });
    writeStack(stack);
    return stack;
  }

  // The previous in-app entry (nearest stack entry that isn't the current page).
  function prevEntry() {
    var id = currentId();
    var stack = readStack();
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i] && stack[i].id !== id && isSafeHref(stack[i].url)) return stack[i];
    }
    return null;
  }

  /* ---- Public: resolve where back() WOULD go (no navigation) ---------------
   * Returns { tier, href, id }. Pure — used by back() and by the nav matrix
   * test harness to assert behavior without navigating.
   * -------------------------------------------------------------------------*/
  function resolveBack(explicitFallbackId) {
    var id = currentId();

    // Tier 1 — explicit validated navigation context from the URL.
    var from = fromParam();
    if (from && from !== id) {
      // Upgrade to the exact origin URL (with its query) if the journey stack
      // has it — otherwise the bare page. Either way the DESTINATION PAGE is
      // dictated by the validated ?from= id (URL is the source of truth).
      var entry = null, stack = readStack();
      for (var i = stack.length - 1; i >= 0; i--) { if (stack[i] && stack[i].id === from) { entry = stack[i]; break; } }
      var href = (entry && isSafeHref(entry.url)) ? entry.url : fileOf(from);
      return { tier: 1, href: href, id: from };
    }

    // Tier 3 candidate (also gates Tier 2): the real previous in-app page.
    var prev = prevEntry();

    // Tier 2 — validated browser history state: only when the browser's own
    // previous entry is genuinely in-app (same-host referrer that matches our
    // recorded previous page). Preserves scroll/restoration via history.back().
    if (prev) {
      var ref = document.referrer || '';
      var sameHost = ref && ref.indexOf(location.host) !== -1;
      var refBase = ref.split('?')[0].split('#')[0].split('/').pop().replace(/\.html?$/i, '');
      if (sameHost && refBase === prev.id && history.length > 1) {
        return { tier: 2, href: prev.url, id: prev.id, useHistory: true };
      }
      // Tier 3 — validated session-scoped journey stack.
      return { tier: 3, href: prev.url, id: prev.id };
    }

    // Tier 4 — safe page-specific fallback.
    var fb = isKnown(explicitFallbackId) ? explicitFallbackId
           : (isKnown(id) && ROUTES[id].fallback) ? ROUTES[id].fallback
           : 'dashboard';
    return { tier: 4, href: fileOf(fb), id: fb };
  }

  /* ---- Public API ----------------------------------------------------------*/

  var HH_Nav = {
    ROUTES: ROUTES,
    isSafeHref: isSafeHref,
    currentId: currentId,
    origin: fromParam,        // validated ?from= id, or null
    resolveBack: resolveBack,

    /* Navigate to a known route id, stamping the trusted origin so the target's
     * back button can return here. `params` are extra query params (id, cat, q…). */
    go: function (targetId, params) {
      if (!isKnown(targetId)) { console.warn('[HH_Nav] unknown route:', targetId); return; }
      var here = currentId();

      // Record our page in the journey stack before leaving.
      if (isKnown(here)) {
        var stack = readStack();
        var last = stack[stack.length - 1];
        if (!last || last.id !== here) { stack.push({ id: here, url: currentUrl() }); writeStack(stack); }
      }

      var qs = new URLSearchParams();
      if (params && typeof params === 'object') {
        Object.keys(params).forEach(function (k) {
          if (params[k] !== undefined && params[k] !== null && params[k] !== '') qs.set(k, String(params[k]));
        });
      }
      if (isKnown(here) && here !== targetId) qs.set('from', here); // trusted origin
      var q = qs.toString();
      location.assign(fileOf(targetId) + (q ? ('?' + q) : ''));
    },

    /* Escape hatch for arbitrary same-origin relative targets (validated). */
    goHref: function (href) {
      if (!isSafeHref(href)) { console.warn('[HH_Nav] blocked unsafe href:', href); return; }
      location.assign(href);
    },

    /* THE back action. Resolves via the mandated 4-tier order. */
    back: function (explicitFallbackId) {
      var r = resolveBack(explicitFallbackId);
      if (r.useHistory) { history.back(); return; }
      if (isSafeHref(r.href)) location.assign(r.href);
      else location.assign('dashboard.html');
    },

    /* Validate a returnTo/next target (auth redirects). Returns a safe href or null. */
    safeReturn: function (raw) {
      if (isKnown(raw)) return fileOf(raw);
      if (isSafeHref(raw)) {
        var base = raw.split('?')[0].split('#')[0].replace(/\.html?$/i, '');
        if (isKnown(base)) return raw; // relative URL whose page is on the allowlist
      }
      return null;
    },

    /* Called once per page load (auto-run below). Reconciles the journey stack
     * and marks browser history state as in-app for Tier 2. */
    init: function () {
      try { reconcileStack(); } catch (_) {}
      try {
        var st = history.state || {};
        st.hhInApp = true; st.hhId = currentId();
        history.replaceState(st, document.title, currentUrl());
      } catch (_) {}
      return this;
    }
  };

  window.HH_Nav = HH_Nav;

  // Auto-initialize as soon as the script runs (head, before page scripts).
  HH_Nav.init();
})();
