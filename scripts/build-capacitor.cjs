#!/usr/bin/env node
/**
 * build-capacitor.cjs — prepare the web assets Capacitor packages.
 *
 * Capacitor's `webDir` is `build-customer-app/`, the same staged output Firebase
 * Hosting deploys. That directory intentionally has NO root index.html: the app
 * lives at `customer-app/` with `shared/` as its sibling, so that every page's
 * `../shared/…` import resolves exactly as it does locally (see
 * stage-hosting.cjs for why that layout is load-bearing).
 *
 * Firebase Hosting bridges the gap with a redirect:
 *     "/"  ->  "/customer-app/index.html"   (302)
 *
 * Capacitor has no server, so there is nothing to perform that redirect. It
 * opens `index.html` at the root of webDir and shows a blank screen if it is
 * missing. This script writes that one missing file.
 *
 * WHY NOT MOVE THE APP TO THE ROOT
 * ────────────────────────────────
 * Flattening `customer-app/` to the root would put `shared/` *above* the root,
 * so `../shared/…` would escape the bundle — the identical bug stage-hosting.cjs
 * was written to prevent on Hosting. The redirect shim is the small, honest fix.
 *
 * WHY NOT GENERATE IT IN stage-hosting.cjs
 * ────────────────────────────────────────
 * That output is also what Firebase deploys, where a real root index.html would
 * compete with the existing "/" redirect. Keeping the shim here means the web
 * deploy is untouched.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'build-customer-app');
// The app opens on the startup router, not on the welcome page. index.html is
// "Get started" (Sign up / Join as artisan) and never asks Firebase whether
// someone is already signed in, so every cold start of the installed app showed
// Sign up to a signed-in customer. splash-screen.html waits for Firebase to
// restore the session (from IndexedDB, no network needed) and only then picks
// dashboard.html or index.html. (Hosting's "/" redirect is untouched.)
const ENTRY = 'customer-app/splash-screen.html';

// Matches the Hosting redirect target. `location.replace` rather than a plain
// assignment so the shim does not become a history entry the back button can
// land on — on a phone that would look like the app closing to a blank page.
const SHIM = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fidus X</title>
<script>location.replace('${ENTRY}');</script>
<meta http-equiv="refresh" content="0;url=${ENTRY}">
<style>html,body{margin:0;height:100%;background:#FEFEFE}</style>
</head>
<body></body>
</html>
`;

function main() {
  console.log('[build-capacitor] refreshing vendored Firebase + staged web assets');
  execFileSync(process.execPath, [path.join(__dirname, 'build-vendor.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'stage-hosting.cjs'), 'customer-app'], { stdio: 'inherit' });

  if (!fs.existsSync(path.join(WEB_DIR, ENTRY))) {
    console.error(`[build-capacitor] FAIL — ${ENTRY} missing from ${WEB_DIR}`);
    process.exit(1);
  }

  fs.writeFileSync(path.join(WEB_DIR, 'index.html'), SHIM, 'utf8');
  console.log(`[build-capacitor] wrote root index.html -> ${ENTRY}`);

  // The bundle must be self-contained. A stray gstatic import would only fail
  // once the app is offline on someone's phone, which is the worst place to
  // discover it — so fail the build here instead.
  let offenders = 0;
  (function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.(js|html)$/.test(e.name)) continue;
      const body = fs.readFileSync(p, 'utf8');
      if (/gstatic\.com\/firebasejs/.test(body) && !/sw\.js$|firebase-messaging-sw\.js$/.test(p)) {
        console.error(`  gstatic import survives in ${path.relative(WEB_DIR, p)}`);
        offenders++;
      }
    }
  })(WEB_DIR);

  if (offenders) {
    console.error(`[build-capacitor] FAIL — ${offenders} file(s) still load Firebase from the CDN`);
    process.exit(1);
  }
  console.log('[build-capacitor] OK — bundle is self-contained');

  // Without Firebase's native config the APK builds, installs and opens — then
  // closes on every login, when PushNotifications.register() reaches
  // FirebaseMessaging.getInstance() (see android/app/build.gradle). Say so here,
  // before the slow Gradle step, rather than on someone's phone.
  // Status bar: the top inset is handled in ONE place, natively
  // (android/.../MainActivity.java pads the WebView's container by the real
  // system-bar insets). A page declaring viewport-fit=cover asks the WebView to
  // draw edge-to-edge and pad itself, which nothing here does. Scans the WHOLE
  // bundle: the root shim written above declared cover too, and the first
  // version of this check (customer-app/ only) missed it.
  const covers = [];
  (function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (/\.html$/.test(e.name) && /name="viewport"[^>]*viewport-fit=cover/.test(fs.readFileSync(p, 'utf8'))) covers.push(path.relative(WEB_DIR, p));
    }
  })(WEB_DIR);
  if (covers.length) {
    console.error(`[build-capacitor] FAIL — viewport-fit=cover would draw these pages under the Android status bar: ${covers.join(', ')}`);
    process.exit(1);
  }
  console.log('[build-capacitor] OK — no page opts out of the native status-bar inset');

  const problem = firebaseConfigProblem();
  if (problem) {
    console.error(`[build-capacitor] FAIL — ${problem}`);
    process.exit(1);
  }
  console.log('[build-capacitor] OK — Firebase native config present for this app id');
}

/** null when android/app/google-services.json is usable for capacitor.config.json's appId. */
function firebaseConfigProblem(root = ROOT) {
  const appId = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8')).appId;
  const file = path.join(root, 'android', 'app', 'google-services.json');
  if (!fs.existsSync(file)) {
    return `android/app/google-services.json is missing. Download it from Firebase Console ` +
           `(project lamax-4fd82) → Project settings → Android app ${appId}. A browser download named ` +
           `"google-services (2).json" is NOT read by Gradle — it must be named exactly google-services.json.`;
  }
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return `google-services.json is not valid JSON (${e.message})`; }
  const packages = (json.client || []).map((c) => c.client_info && c.client_info.android_client_info &&
    c.client_info.android_client_info.package_name);
  if (!packages.includes(appId)) return `google-services.json has no client for ${appId} (found: ${packages.join(', ') || 'none'})`;
  return null;
}

module.exports = { firebaseConfigProblem };

if (require.main === module) main();
