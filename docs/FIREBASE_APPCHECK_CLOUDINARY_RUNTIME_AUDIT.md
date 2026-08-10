# Firebase App Check and profile-image runtime audit

Date: 2026-07-24

## Confirmed root causes

### App Check

The shared Firebase module previously instantiated Auth, Firestore, Storage, and
Messaging before calling `initializeAppCheck`. It also always used the production
reCAPTCHA v3 provider on `localhost` and `127.0.0.1`. The reported runtime was
`127.0.0.1:5501`, so local development attempted real reCAPTCHA attestation
instead of an explicitly registered App Check debug token. A failed attestation
then affected every Firebase product requesting credentials.

Stable, unhashed JavaScript URLs were additionally served with a one-year
`immutable` header. That could mix old and new Firebase modules after a deploy.

The source uses `ReCaptchaV3Provider`. The Firebase Console must therefore have
this exact web app registered with a reCAPTCHA v3 key. The repository cannot
inspect provider type, key ownership, domain registration, or enforcement state
in the Firebase/Google consoles; those remain required operator verification.

### Cloudinary

Cloudinary does not require a file extension when delivering an image by public
ID. The failing request was already an untransformed `image/upload` URL and
returned 404, so adding `.jpg` would fabricate metadata. The stored
`profileImageId` plus `profileImageVersion` does not resolve in cloud
`dnwwglbl9`. The record is therefore stale/malformed or references an asset that
was deleted/cleaned up, uploaded to another cloud/resource type, or never
successfully committed under that identifier.

Classic inline cache painters manually reconstructed the URL before the shared
module loaded. Cached and live profile paints could consequently request the
same known-broken asset repeatedly.

## Architectural correction

- The default Firebase app is idempotent through `getApps/getApp`.
- App Check is initialized before every Firebase product.
- `firebaseReady` provides a stable initialization boundary without changing
  existing public service APIs.
- Local App Check debug mode is selected automatically only on `localhost` or
  `127.0.0.1`. No production hostname can activate it and no debug token is
  stored in source.
- Hosting now revalidates unversioned JS/CSS instead of treating it as immutable.
- `normalizeProfileImage` is the canonical compatibility layer for current
  public IDs, legacy Cloudinary URLs, empty values, and malformed metadata.
- `bindAvatarImage` owns DOM assignment, a single non-recursive fallback, and
  session-level memory of failed URLs.
- Inline cached profile painters no longer construct remote Cloudinary URLs.
- Dashboard auth, profile, and unread-count listeners are all explicitly
  unsubscribed on auth change/page exit.

The upload/write schema remains backward compatible:
`profileImageId` is the Cloudinary public ID and `profileImageVersion` is the
numeric upload version. The existing server-coordinated begin/upload/commit
replacement protocol remains authoritative.

## Required Firebase Console actions

1. In App Check, select web app
   `1:1034220501833:web:bba9ad6f78881029a0f898`.
2. Confirm its provider is **reCAPTCHA v3**, matching the source. If the console
   app is registered for Enterprise, migrate the code and key together; do not
   mix provider types.
3. Confirm the configured site key belongs to Firebase project `lamax-4fd82`.
4. Confirm production domains include the actual customer domain,
   `lamax-4fd82.web.app`, its Firebase Hosting alias, and any real custom domain.
5. Do not authorize localhost on the production reCAPTCHA key. Use a debug token.
6. Review App Check metrics before confirming enforcement for Auth, Firestore,
   Storage, and Functions.

### Local debug-token procedure

Open the app on localhost/127.0.0.1 and copy the generated `AppCheck debug
token` from the console. In Firebase Console:
App Check -> Apps -> the web app -> Manage debug tokens -> add the token. Reload
again. Never commit or share that token. To temporarily test the real provider
on localhost, explicitly opt out and reload:

```js
localStorage.setItem('hh_app_check_debug', '0');
location.reload();
```

Remove that override to restore safe local debug behavior.

## Cloudinary dashboard actions

1. Search Media Library in cloud `dnwwglbl9` for the exact stored public ID.
2. If absent, do not rename the Firestore value or append an extension. Ask the
   customer to re-upload through the current profile flow.
3. Confirm preset `hh_profiles` uploads as `image/upload` into the allocated
   `customers/<uid>/...` or `artisans/<uid>/...` public ID.
4. Restrict the unsigned preset to images, the intended folder, permitted
   formats, and a maximum size no larger than the client limit. Keep API secrets
   in Cloud Functions secrets only.
5. Resolve the account's strict-transformation policy separately before
   restoring transformed delivery. The app intentionally uses originals now.

## Existing-record migration

No URL is fabricated:

- Valid public ID plus optional positive numeric version: retain.
- HTTPS URL from this Cloudinary cloud: render as legacy and mark for migration.
- Empty image fields: use generated initials.
- Mixed, unsafe, malformed, or unresolved data: use generated initials and mark
  `data-avatar-needs-repair`/`data-avatar-failed` for the render cycle.
- A confirmed missing asset must be repaired by a user re-upload. The current
  commit flow writes authoritative replacement metadata.

A privileged migration may later scan customer/artisan documents and report
records needing repair, but it must not guess formats or public IDs.

## Verification performed

- Focused `node --check` on all changed JavaScript: passed.
- Repository syntax gate: 151 JavaScript files and 86 inline scripts: passed.
- `firebase.json` JSON parse: passed.
- `git diff --check` for changed runtime files: passed.
- Static audit found one shared App Check initializer; the FCM service worker's
  Firebase initialization is isolated in its worker context and is expected.
- Listener ownership audit confirms dashboard profile/unread listeners and the
  auth listener now have cleanup handles.

Not performed from this environment: authenticated production/staging browser
tests, Firebase Console inspection, App Check enforcement verification,
Cloudinary Media Library inspection, or mutation of real customer records.

## Rollback

Revert the changes in:

- `shared/js/backend/providers/firebase/firebaseConfig.js`
- `shared/js/services/cloudinaryService.js`
- `customer-app/js/dashboardBadge.js`
- `customer-app/js/pages/profilePage.js`
- `customer-app/dashboard.html`
- `customer-app/profile.html`
- `firebase.json`

Do not roll back by disabling App Check enforcement or exposing a debug token.

## Production-readiness verdict

**Code-ready, environment verification required.** The initialization order,
cache policy, listener cleanup, normalization, and failure behavior are suitable
for deployment. Production is not truthfully certified until the console-side
provider/key/domain checks pass and authenticated tests succeed with App Check
enforcement enabled.
