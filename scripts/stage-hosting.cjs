#!/usr/bin/env node
/**
 * stage-hosting.js  —  Firebase Hosting predeploy staging
 * ---------------------------------------------------------------------------
 * The apps are authored to be served from the REPO ROOT (`serve .`), so pages
 * reference shared code as `../shared/...` (one level above the app dir) and the
 * service worker uses an absolute `/customer-app/` scope.
 *
 * Each Firebase Hosting target, however, deploys only ONE public dir as the
 * site root — which would put the app dir AT the root and make `../shared/...`
 * escape above it (404 in production).
 *
 * Fix: stage a build dir that MIRRORS the local sibling layout —
 *   build-<app>/<app-dir>/   (the app)
 *   build-<app>/shared/      (shared code)
 * so `../shared/...` resolves identically to local, with ZERO page edits.
 *
 * Usage:  node scripts/stage-hosting.js <app-dir>   e.g. customer-app
 * Output: build-<app-dir>/  (gitignored)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const appDir = process.argv[2];
if (!appDir) {
  console.error('[stage-hosting] Missing app dir. Usage: node scripts/stage-hosting.js <app-dir>');
  process.exit(1);
}

const root    = path.resolve(__dirname, '..');
const srcApp  = path.join(root, appDir);
const srcShared = path.join(root, 'shared');
const outDir  = path.join(root, `build-${appDir}`);

if (!fs.existsSync(srcApp))    { console.error(`[stage-hosting] App dir not found: ${srcApp}`); process.exit(1); }
if (!fs.existsSync(srcShared)) { console.error(`[stage-hosting] shared/ not found: ${srcShared}`); process.exit(1); }

// Skip these heavy/irrelevant entries when copying shared/.
const SKIP = new Set(['node_modules', '.git', '.DS_Store']);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) fs.copyFileSync(fs.realpathSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

// Clean previous build for a deterministic result.
fs.rmSync(outDir, { recursive: true, force: true });

copyDir(srcApp,    path.join(outDir, appDir));
copyDir(srcShared, path.join(outDir, 'shared'));

// Sanity-check: ensure the build produced at least one HTML file.
// An empty build would silently wipe the live site on deploy.
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else n++;
  }
  return n;
}
const fileCount = countFiles(outDir);
if (fileCount === 0) {
  console.error(`[stage-hosting] ABORT: build-${appDir}/ is empty after staging. Deploy cancelled.`);
  process.exit(1);
}
const htmlCount = fs.readdirSync(path.join(outDir, appDir))
    .filter(f => f.endsWith('.html')).length;
if (htmlCount === 0) {
  console.error(`[stage-hosting] ABORT: no HTML files found in build-${appDir}/${appDir}/. Deploy cancelled.`);
  process.exit(1);
}

console.log(`[stage-hosting] Staged ${appDir} + shared -> build-${appDir}/ (${fileCount} files, ${htmlCount} HTML pages)`);
