#!/usr/bin/env node
/**
 * build-vendor.cjs — vendor the Firebase SDK locally.
 *
 * WHY
 * ───
 * Every page imported Firebase from https://www.gstatic.com/firebasejs/10.8.0/…
 * — 71 import sites across 45 files. That is a network round trip on the
 * critical path of every full-document navigation, and inside a Capacitor
 * bundle it means the app cannot start at all without connectivity: the
 * modules never resolve, so auth and Firestore are never constructed.
 *
 * Copying the gstatic files in does NOT work. They reference each other by
 * absolute URL — firebase-firestore.js contains, literally:
 *
 *     from"https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js"
 *
 * so a "local" copy still fetches gstatic at runtime. Resolving that properly
 * needs a real bundler, which is what this script is.
 *
 * WHY CODE SPLITTING IS NOT OPTIONAL
 * ──────────────────────────────────
 * Bundling each entry point independently would give every one of them its own
 * copy of the @firebase/app internals — and therefore its own app registry.
 * `getApps()` in firebase-auth.js would not see the app created in
 * firebase-app.js, and the named-app singleton the admin dashboard relies on
 * would silently break. `splitting: true` hoists the shared internals into one
 * chunk so there is exactly one Firebase instance, exactly as the CDN provided.
 *
 * Splitting also preserves selective loading: a page that only needs auth does
 * not pull in the 434 KB Firestore build. That matters on Ghanaian mobile data
 * and is why this is not one combined bundle.
 *
 * OUTPUT SHAPE
 * ────────────
 * Filenames deliberately mirror the CDN's, so rewriting call sites is a pure
 * prefix swap and the diff stays reviewable:
 *
 *   https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js
 *   ../shared/vendor/firebase/firebase-auth.js
 *
 * VERSION
 * ───────
 * Pinned to the exact version the CDN was serving (see package.json). Changing
 * delivery and changing SDK version at the same time would make any regression
 * impossible to attribute. Upgrade separately, on purpose.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shared', 'vendor', 'firebase');
const TMP = path.join(ROOT, 'node_modules', '.hh-vendor-entries');

/** CDN filename -> npm subpath. Only what the codebase actually imports. */
const MODULES = {
  'firebase-app':       'firebase/app',
  'firebase-auth':      'firebase/auth',
  'firebase-firestore': 'firebase/firestore',
  'firebase-functions': 'firebase/functions',
  'firebase-storage':   'firebase/storage',
  'firebase-messaging': 'firebase/messaging',
  'firebase-app-check': 'firebase/app-check',
};

function main() {
  const version = require(path.join(ROOT, 'node_modules', 'firebase', 'package.json')).version;
  console.log(`[build-vendor] firebase@${version}`);

  // Generate one re-export entry per CDN-named module.
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const entryPoints = Object.entries(MODULES).map(([name, spec]) => {
    const file = path.join(TMP, `${name}.js`);
    fs.writeFileSync(file, `export * from '${spec}';\n`, 'utf8');
    return file;
  });

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  esbuild.buildSync({
    entryPoints,
    outdir: OUT,
    bundle: true,
    format: 'esm',
    splitting: true,          // see header — required for a single app registry
    target: ['es2020'],       // Android WebView / WKWebView floor
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });

  // The whole point is that nothing reaches gstatic at runtime. Verify it
  // rather than assume it — a missed reference would reintroduce the exact
  // failure this script exists to remove, and would only show up offline.
  const offenders = [];
  let bytes = 0;
  for (const f of fs.readdirSync(OUT)) {
    const p = path.join(OUT, f);
    const body = fs.readFileSync(p, 'utf8');
    bytes += Buffer.byteLength(body);
    if (body.includes('gstatic.com/firebasejs')) offenders.push(f);
  }

  const files = fs.readdirSync(OUT).sort();
  for (const f of files) {
    const kb = (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
    console.log(`  ${String(kb).padStart(5)} KB  ${f}`);
  }
  console.log(`[build-vendor] ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB total`);

  if (offenders.length) {
    console.error(`[build-vendor] FAIL — gstatic references survive in: ${offenders.join(', ')}`);
    process.exit(1);
  }
  console.log('[build-vendor] OK — no gstatic references remain');

  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
