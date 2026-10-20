# Artisan app platforms (AR-16, 2026-10-20)

## Decision

The artisan app ships as an **installable web app (PWA)** on the existing
`lamax-artisan` Hosting site. A **native Android artisan app is not built yet**;
the reasons and the plan are below. Nothing in `android/` was changed: it builds
the customer app only, and must keep doing so.

## Web app — what exists now

| Piece | File | Status |
|---|---|---|
| Manifest | `artisan-app/manifest.webmanifest` | Done — name, scope `/artisan-app/`, start `dashboard.html`, standalone, brand colours from `css/design-system.css` |
| App-shell worker | `artisan-app/sw.js` (scope `/artisan-app/`) | Done — see caching policy in the file header |
| Offline page | `artisan-app/offline.html` | Done — static, no account data |
| Registration | `artisan-app/js/pwa.js`, linked from every page | Done |
| Hosting headers | `firebase.json` (artisan target) | Done — worker and manifest always revalidated |
| Push worker | `/firebase-messaging-sw.js` (scope `/`) | Unchanged — a separate registration; the app-shell worker has no push handlers |
| **Icons** | — | **Blocked — no square Fidus X icon exists** |

`npm run check:pwa` reports each app's real installability (it reads every
icon's pixel size). Today:

- **artisan-app — not installable**: no icons declared. Declaring the old
  HandyHub wordmark would be wrong twice (old brand; 384×242, not square), and
  the Android launcher icons are Capacitor's placeholder.
- **customer-app — not installable either** (pre-existing): its manifest
  declares `handyhub-logo.png` as 192×192 and 512×512; the file is 384×242.

**To finish:** supply a square Fidus X mark as PNG at 192×192 and 512×512 (plus
a 512×512 maskable variant with the mark inside the central 80% safe zone).
Put them in `artisan-app/icons/`, list them in the manifest, and run
`node scripts/check-pwa.cjs --strict`. The same assets fix the customer app.

### Caching policy, in one paragraph

Only this origin's static files are ever cached: scripts and styles network-first
(cache used only offline, so a page and its scripts never come from different
releases), images and fonts stale-while-revalidate. Pages are never cached — an
offline navigation shows `offline.html`. Firestore, Functions, Auth, Paystack and
Cloudinary are cross-origin and always bypass the worker, as do non-GET
requests, requests with an `Authorization` header, Hosting's `/__/` paths (the
Auth popup handler), the push worker and `release-manifest.json`. No customer
detail, payment response or sign-in state can be served from this cache.

## Native Android artisan app — not built, and why

The Capacitor project (`capacitor.config.json`, `android/`) is single-app: one
`appId` (`com.handyhub.customer`, the Play/signing identity — not to be renamed,
see the Fidus X rename policy), one `webDir` (`build-customer-app`). Building the
artisan app safely needs things that do not exist yet:

1. **An application ID and Firebase Android app** for the artisan app, with its
   own `google-services.json` — FCM push (the artisan's job alerts) depends on it.
2. **Signing**: a new upload key and Play Console listing (a separate app).
3. **Launcher icons and splash** — the same missing Fidus X assets as above.
4. **A second web build**: `scripts/stage-hosting.cjs artisan-app` already
   produces `build-artisan-app/`; Capacitor needs it as a `webDir`.

### Plan (when 1–3 are available)

- Use a **second Capacitor project**, e.g. `native/artisan/` with its own
  `capacitor.config.json` (`appId` e.g. `com.fidusx.artisan`, `webDir:
  ../../build-artisan-app`) and its own `android/`. Do **not** add a product
  flavour to the customer project: Capacitor reads one config and one
  `webDir`, and flavours sharing `MainActivity`, `AndroidManifest.xml` and the
  Capacitor bridge invite cross-contamination of app links and push config.
- Copy nothing from `android/` by hand; generate with `npx cap add android`
  inside the new project, then add `google-services.json` for the artisan app.
- The artisan pages already use the native push path when
  `window.Capacitor.Plugins.PushNotifications` is present
  (`pushNotificationService.js` → `initNativePush`), and register tokens with
  `fcmPlatform: 'android'`, which `functions/notifications.js` already shapes.
- Release: add the artisan build to `docs/RELEASE.md` alongside the customer
  build, from the same tag.
- Verify: install on a device, receive a job-offer push with the app closed,
  open it from the notification, accept the job.
