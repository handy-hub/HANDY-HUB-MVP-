#!/usr/bin/env node
'use strict';

/**
 * check-pwa.cjs — is each web app ACTUALLY installable? (AR-16)
 *
 * "A manifest exists" is not installability. Browsers (Chrome's criteria,
 * which Android's install prompt uses) require a parseable manifest with a
 * name, start_url inside scope, a standalone-type display, and icons that are
 * real, square images of at least 192 px and 512 px with purpose "any". This
 * reads every declared icon's PNG header to check its true pixel size, and
 * confirms the app-shell worker file exists.
 *
 *   node scripts/check-pwa.cjs           report; exit 1 only if a manifest is
 *                                        structurally broken
 *   node scripts/check-pwa.cjs --strict  also exit 1 if an app is not installable
 *
 * Exported for tests: evaluateApp().
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPS = [
    { app: 'artisan-app',  manifest: 'artisan-app/manifest.webmanifest', worker: 'artisan-app/sw.js', offline: 'artisan-app/offline.html' },
    { app: 'customer-app', manifest: 'customer-app/manifest.json',       worker: 'customer-app/sw.js', offline: null },
];

/** Width × height from a PNG's IHDR chunk, or null if it is not a PNG. */
function pngSize(file) {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function evaluateApp({ manifest, worker, offline }) {
    const errors = [];        // structural: the manifest itself is wrong
    const blockers = [];      // the app is not installable until these are fixed
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(ROOT, manifest), 'utf8')); }
    catch (e) { return { manifest, ok: false, installable: false, errors: [`${manifest} does not parse: ${e.message}`], blockers }; }

    for (const k of ['name', 'short_name', 'start_url', 'scope', 'display']) if (!m[k]) errors.push(`missing "${k}"`);
    if (m.display && !['standalone', 'fullscreen', 'minimal-ui'].includes(m.display)) errors.push(`display "${m.display}" is not installable`);
    if (m.start_url && m.scope && !String(m.start_url).startsWith(m.scope)) errors.push('start_url is outside scope');
    if (!worker || !fs.existsSync(path.join(ROOT, worker))) blockers.push(`service worker ${worker} is missing`);
    if (offline && !fs.existsSync(path.join(ROOT, offline))) blockers.push(`offline page ${offline} is missing`);

    const icons = Array.isArray(m.icons) ? m.icons : [];
    const usable = [];
    for (const icon of icons) {
        const rel = String(icon.src || '').replace(/^\//, '');
        const file = path.join(ROOT, rel.startsWith('shared/') || rel.includes('/') ? rel : path.join(path.dirname(manifest), rel));
        if (!fs.existsSync(file)) { blockers.push(`icon ${icon.src} does not exist`); continue; }
        const size = pngSize(file);
        if (!size) { blockers.push(`icon ${icon.src} is not a PNG`); continue; }
        const declared = String(icon.sizes || '').split(/\s+/).filter(Boolean);
        const actual = `${size.width}x${size.height}`;
        if (size.width !== size.height) blockers.push(`icon ${icon.src} is ${actual}, not square`);
        else if (!declared.includes(actual)) blockers.push(`icon ${icon.src} is ${actual} but declares ${declared.join(' ') || 'no size'}`);
        else if (!String(icon.purpose || 'any').split(/\s+/).includes('any')) blockers.push(`icon ${icon.src} has no "any" purpose`);
        else usable.push(size.width);
    }
    if (!icons.length) blockers.push('no icons declared — a square Fidus X icon (192 px and 512 px PNG) is needed');
    if (icons.length && !usable.some((w) => w >= 192)) blockers.push('no usable icon of at least 192 px');
    if (icons.length && !usable.some((w) => w >= 512)) blockers.push('no usable icon of at least 512 px');

    return { manifest, ok: errors.length === 0, installable: errors.length === 0 && blockers.length === 0, errors, blockers };
}

if (require.main === module) {
    const strict = process.argv.includes('--strict');
    let broken = 0, notInstallable = 0;
    for (const a of APPS) {
        const r = evaluateApp(a);
        console.log(`${r.installable ? '✓' : '✗'} ${a.app}: ${r.installable ? 'installable' : 'NOT installable'}`);
        for (const e of r.errors)   console.log(`    error:   ${e}`);
        for (const b of r.blockers) console.log(`    blocker: ${b}`);
        if (!r.ok) broken++;
        if (!r.installable) notInstallable++;
    }
    process.exit(broken || (strict && notInstallable) ? 1 : 0);
}

module.exports = { evaluateApp, pngSize, APPS };
