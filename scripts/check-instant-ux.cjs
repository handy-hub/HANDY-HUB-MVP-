#!/usr/bin/env node
'use strict';

/**
 * check-instant-ux.cjs — guards the RENDER FIRST law (see CLAUDE.md §1).
 *
 * HandyHub is a multi-page app: every navigation is a full document load, so the
 * only way a screen can feel instant is to paint from a navigation-surviving
 * cache before the network is consulted. Documentation alone did not hold that
 * line — two caching bugs shipped that looked correct in review:
 *
 *   • a 10-minute TTL that made the promo banner shimmer on most visits;
 *   • a cache read under a bare key and written under a uid-scoped one, so the
 *     notification cache was never once read.
 *
 * Both were silent. This check exists to make that class of mistake loud.
 *
 * WHAT IT CHECKS
 *   1. Hand-rolled uid-scoped cache keys. Building a key from a uid outside
 *      instantView/persistentCache is how the read/write mismatch happened. Use
 *      mountInstantView, which resolves the uid synchronously before first read.
 *   2. Short TTLs. A cache whose paintable window is minutes is a cache that
 *      misses on ordinary return visits. TTL (paintable) and staleness (fresh)
 *      are different concerns; see instantView.js.
 *   3. Listed screens must actually paint before auth resolves — they must reach
 *      the cache either through instantView or hh_last_session_uid.
 *
 * Deliberately NOT a general "you must cache" rule: some screens legitimately
 * have nothing worth caching. It targets the specific, proven failure modes.
 *
 * Exit 0 = clean, 1 = violations, 2 = check itself broke.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Screens that MUST paint from cache before auth resolves. */
const INSTANT_SCREENS = [
  'customer-app/dashboard.html',
  'customer-app/booking.html',
  'customer-app/profile.html',
  'customer-app/js/pages/notificationPage.js',
];

/** Modules allowed to touch cache internals directly. */
const CACHE_OWNERS = [
  'shared/js/services/instantView.js',
  'shared/js/services/persistentCache.js',
  'shared/js/services/stateService.js',
  // Sign-out must enumerate and delete uid-scoped keys by construction — that is
  // the opposite of the bug this rule guards, so it is legitimately exempt.
  'shared/js/utils/clearUserSession.js',
];

/**
 * TTL names that are NOT first-paint caches, so the "must be paintable for
 * hours" rule does not apply:
 *   FAILED/RETRY — negative caches; SHORT is the point.
 *   LOC/GEO      — positional freshness, where old coordinates are wrong, not stale.
 *   LOCK/TOKEN   — security windows that must expire quickly.
 */
const NON_PAINT_TTL = /FAILED|RETRY|LOCK|TOKEN|OTP|SESSION|LOC_|GEO_|DEBOUNCE|TIMEOUT/i;

/** Safely evaluate a pure-arithmetic TTL literal like `24 * 60 * 60_000`. */
function evalMs(expr) {
  const cleaned = expr.replace(/_/g, '').trim();
  if (!/^[\d\s*+()]+$/.test(cleaned)) return null;   // refuse anything non-numeric
  try {
    const v = Function(`"use strict";return (${cleaned});`)();
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** Anything under these roots is scanned for hand-rolled caching. */
const SCAN_DIRS = ['customer-app/js', 'artisan-app/js', 'shared/js'];

const violations = [];

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── 1 + 2. Scan modules for hand-rolled caching ─────────────────────────────
for (const d of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, d))) {
    const relPath = rel(file);
    if (CACHE_OWNERS.includes(relPath)) continue;

    const src = fs.readFileSync(file, 'utf8');

    // Memory-only caches cannot survive a navigation, so their TTL has no
    // bearing on first paint. They exist to deduplicate reads WITHIN one page
    // load, where a short TTL is correct. Only persisted caches are governed
    // by the paintable-window rule.
    const isMemoryOnly = /createMemoryCache|memoryCacheService/.test(src)
                      && !/localStorage|sessionStorage|persistentCache/.test(src);
    if (isMemoryOnly) continue;

    const lines = src.split('\n');

    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // comments
      const n = i + 1;

      // Hand-built uid-scoped storage key: 'x_' + uid, `x_${uid}`, etc.
      const uidKey = /(localStorage|sessionStorage)[^\n]*(\+\s*['"`]?_?['"`]?\s*\+?\s*\w*[Uu]id|\$\{[^}]*[Uu]id)/.test(line)
                  || /_CACHE_KEY\s*=[^\n]*[Uu]id/.test(line);
      if (uidKey) {
        violations.push({
          file: relPath, line: n, rule: 'hand-rolled uid cache key',
          detail: line.trim().slice(0, 96),
          fix: 'Use mountInstantView() — it resolves the uid before the first read, so read and write keys cannot diverge.',
        });
      }

      // A first-paint cache whose paintable window is minutes will miss on
      // ordinary return visits — exactly the promo-banner bug.
      const ttl = line.match(/const\s+([A-Z0-9_]*TTL[A-Z0-9_]*)\s*=\s*([^;/]+)/);
      if (ttl) {
        const [, name, expr] = ttl;
        if (!NON_PAINT_TTL.test(name)) {
          const ms = evalMs(expr);
          if (ms !== null && ms > 0 && ms < 60 * 60 * 1000) {
            violations.push({
              file: relPath, line: n, rule: `first-paint TTL is only ${Math.round(ms / 60000)} min`,
              detail: line.trim().slice(0, 96),
              fix: 'TTL is how long a payload stays PAINTABLE, not how long it stays FRESH. '
                 + 'Use a long ttlMs plus a short staleMs (see instantView.js).',
            });
          }
        }
      }
    });
  }
}

// ── 3. Instant screens must actually reach a cache before auth ──────────────
for (const screen of INSTANT_SCREENS) {
  const full = path.join(ROOT, screen);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  const paintsEarly = src.includes('mountInstantView')
                   || src.includes('hh_last_session_uid')
                   || src.includes('resolveSessionUid');
  if (!paintsEarly) {
    violations.push({
      file: screen, line: 0, rule: 'screen no longer paints before auth',
      detail: 'no mountInstantView / resolveSessionUid / hh_last_session_uid found',
      fix: 'This screen is required to render cached content before auth resolves. Restore it via mountInstantView().',
    });
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (violations.length) {
  console.error(`\n✗ ${violations.length} instant-UX violation(s) — see CLAUDE.md §1\n`);
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? ':' + v.line : ''}`);
    console.error(`    ${v.rule} — ${v.detail}`);
    console.error(`    fix: ${v.fix}\n`);
  }
  console.error('RENDER FIRST. FETCH SECOND. A screen that waits on the network');
  console.error('when it could have painted from cache is a regression.\n');
  process.exit(1);
}

console.log('✓ Instant-UX contract intact — no hand-rolled caches, no short TTLs,');
console.log('  and every required screen still paints before auth resolves.');
