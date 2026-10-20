# Push notifications

How a notification reaches a Fidus X user, what broke it until 2026-10-20, and how to
prove it works on a real device. The tests (`npm run test:push`) prove every part of
the pipeline except the last hop to a device; that hop is checked by hand, below.

## The pipeline

1. **Event.** A Cloud Function calls `sendNotification` (customers) or
   `sendArtisanNotification` (artisans) in `functions/notifications.js`. A job offer
   comes from `functions/dispatch.js` and carries `metadata.expiresAtMs`, which is the
   offer's `responseDeadline`.
2. **In-app record first.** A `customer_notifications` document is written for both
   audiences. This is the inbox, and it is written whatever happens to the push.
3. **Push, awaited.** If the user has an `fcmToken`, the message is built by
   `buildFcmMessage` and sent, and the send is awaited. Cloud Functions (2nd gen)
   throttle CPU once the request returns, so an un-awaited send can stall.
   - **Web tokens** get data-only messages. The service worker draws them, so links
     get the app's folder, an offer that expired in transit says so, and nothing is
     shown twice.
   - **Native tokens** (`fcmPlatform` `android` / `ios`, from the Capacitor app) get a
     `notification` block, because the operating system draws it while the app is closed.
   - **Offer expiry.** An offer's push has a TTL equal to the time left. A lapsed offer
     is not pushed at all, but the in-app record is still written.
   - **Dead tokens.** A token FCM reports as not registered is cleared, together with its
     platform, but only if it is still the stored token. A fresher one saved during the
     send survives.
4. **Service worker.** `shared/push/firebase-messaging-sw.js` is copied by
   `scripts/stage-hosting.cjs` to the **site root** of the customer and artisan builds.
   It is served at `/firebase-messaging-sw.js` with `Cache-Control: no-cache`
   (`firebase.json`).
5. **Registration.** `shared/js/services/pushNotificationService.js` registers
   `/firebase-messaging-sw.js?app=…&apiKey=…` at scope `/`. The worker receives the
   page's own Firebase config, so there is one config per environment. The service then
   asks for permission, gets the FCM token, and saves `fcmToken`, `fcmPlatform` and
   `fcmTokenUpdatedAt`, but only when the token changed.
6. **Status.** `getPushState()` and the `fx:push-state` event report a state from
   `shared/js/services/pushState.js`. Only a saved token counts as **on**. The artisan
   dashboard shows a banner for every other state, with a button where a button can fix
   it.

## The fallback when push is not there

The artisan dashboard listens live for pending offers. While it is open, push is not
the only way an offer reaches the artisan:

- **New offer.** An offer that arrives is announced with a toast, a vibration, a
  flashing tab title when hidden, and a local notification when permission is granted.
  The local notification uses the push's tag, so the two never stack.
- **Expiry.** The countdown reads the deadline in any shape it arrives in
  (`shared/js/domain/jobOffers.js`). When an offer lapses, Accept is withdrawn.

## What was broken (2026-07-02 → 2026-10-20)

- **No worker at the root.** `/firebase-messaging-sw.js` returned `login.html` on both
  sites. The staged hosting layout moved each app into a subfolder, and the only worker
  file was `/customer-app/firebase-messaging-sw.js`; the artisan app had none.
  Registration failed silently, and production held **0** push tokens for artisans and
  customers.
- **Wrong links.** Notification links were `/jobs.html`-style, outside every app
  folder.
- **Duplicate displays.** Web messages carried a `notification` block, which the browser
  SDK would have drawn a second time.
- **Unawaited sends.** The send was fire-and-forget.

## Manual verification on a real device

Run this after deploying the functions and hosting together: staging first, or
production with a pilot artisan's device. Real delivery cannot be unit-tested.

1. **Worker served as JavaScript.** Run
   `curl -sI https://<site>/firebase-messaging-sw.js`. Expect `200`,
   `content-type: text/javascript` or `application/javascript`, and
   `cache-control: no-cache, must-revalidate`. Do this for the artisan site and the
   customer site.
2. **Token saved.** On the device, sign in to the artisan app and allow notifications.
   In DevTools → Application → Service Workers, `/firebase-messaging-sw.js` should be
   *activated* at scope `/`. The dashboard should show no job-alert banner.
3. **The token as FCM sees it.** Without delivering anything, run:

   ```bash
   node scripts/send-test-push.cjs --project <project> --role artisan --uid <uid> --validate
   ```

   FCM must accept the message and token.
4. **Delivery.** Close or background the app, then run the same command with `--send`
   in place of `--validate`. The notification must appear. Tap it: it must open
   `/artisan-app/dashboard.html`.
5. **A real offer.** Create a test booking that dispatches to that artisan. A
   "New Booking Request" notification must arrive within seconds, stay on screen, and
   open the dashboard, where the offer counts down. Let it expire. Accept must be
   withdrawn, and the offer moves on within a minute.
6. **The fallback.** In the browser's site settings, block notifications and reload the
   dashboard. The banner must say alerts are blocked. Dispatch another test offer: it
   must appear on the open dashboard with a toast.
7. **Logs.** Run
   `gcloud logging read 'textPayload:"FCM push"' --project <project> --freshness=1h`.
   There must be one `FCM push → artisan=…` line per notification and no
   `FCM push failed` lines.
