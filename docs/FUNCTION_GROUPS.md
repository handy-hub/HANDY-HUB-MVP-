# Function groups

One deployed function per **group** of callable actions, in place of one small
function per action. Started 2026-10-22 on `feat/dispatch-sweep-and-function-groups`.

## Why

europe-west1 gives this project **20 vCPU** of running Cloud Run instances
(CLAUDE.md §4). With one function per action, each serving **one request at a
time**, that budget was spent (18.00 of 18 with every function warm once), so
more simultaneous users meant more instances we could not afford.

A group router has a full vCPU and serves **many requests at once**
(`concurrency`), dispatching on `action` to the action's existing handler.

| Group | Actions | Instance |
|---|---|---|
| `bookingActions` | getPricingQuote, createInspectionBooking, payCalloutFee, payEmergencyCallout, completeInspection, cancelInspectionBooking, respondToJobOffer, submitJobQuote, approveJobQuote, rejectJobQuote | 1 vCPU, 1 GiB, 80 at once |
| `walletActions` | setSecurityPin, initiateTopupCharge, verifyTopupNow, submitTopupOtp, processWithdrawal, processArtisanWithdrawal | 1 vCPU, 1 GiB, 20 at once (scrypt) |
| `accountActions` | *not started* — signup OTP, account deletion, artisanAccount, profile photos | |
| `adminActions` | *not started* — verification, disputes, escrow repair, backfills | |

The single list of members is `shared/js/domain/callableGroups.js`; the server
reads its generated mirror `functions/shared/callableGroups.js`
(`npm run lint:shared` fails if they differ).

## What does not change

- **The handler.** The router calls the action's own export (`.run`) with the
  caller's auth and `payload` as the data. Auth, rate limits, validation and
  error codes are the same code as before. For each grouped action,
  `tests/callable-groups.test.cjs` checks that the router and the per-action
  function give the same answer.
- **Money.** The router adds no money path. Top-ups still credit only through
  `settleTopupByReference`.
- **The per-action functions.** They stay deployed. Installed Android builds and
  cached pages call them by name. `tests/functions-capacity.test.cjs` fails if
  one is removed.

## Clients

`shared/js/services/callable.js`: `callable(name)` is a drop-in for
`httpsCallable(firebaseFunctions, name)`. A grouped action goes to its router as
`{ action, payload }`.

It calls the action directly **only when the router never ran**:

- a bare 404 (the router is not deployed);
- a bare platform 403 (the invoker grant is missing, CLAUDE.md §4);
- `unimplemented` with reason `unknown_action` (the router is older than the client).

A handler's own error always carries a message, and is never retried, because
retrying could pay twice. All of this was checked against production: a missing
function answers with an HTML 404 page, and the SDK reports it as a bare `not-found`.

## Budget (`npm run test:capacity`)

| | vCPU, every function warm once |
|---|---|
| Before | 18.00 |
| Everything current clients call (routers in, grouped actions out) | **15.83** |
| + the 16 per-action functions kept for old clients, if **all** were warm | 20.00 |

That last row is the worst case during the transition. It is only reached if old
clients warm all 16 at once on top of everything else, and then there is no
headroom left for a deploy. Release B removes them.

## Rollout

1. **Deploy the functions first** (from a clean tagged checkout, docs/RELEASE.md,
   `FUNCTIONS_DISCOVERY_TIMEOUT=90`). This creates `bookingActions` and
   `walletActions`. Every other function is updated in place.
2. **Probe the routers.** Signed out, each must answer **401**, not 403:
   ```bash
   for f in bookingActions walletActions; do
     curl -s -o /dev/null -w "$f %{http_code}\n" -X POST -H 'Content-Type: application/json' \
       -d '{"data":{}}' https://europe-west1-lamax-4fd82.cloudfunctions.net/$f
   done
   ```
   If either answers 403, grant `allUsers` → `roles/run.invoker` on its Cloud Run
   service. Clients would still work, by falling back, but would pay an extra
   round trip until then.
3. **Deploy hosting** (customer, artisan, admin) from the same tag.
4. Watch the logs for `[callable] … unavailable`. Seeing it after step 2 means a
   router is not reachable.

The order is forgiving. Clients deployed before the routers fall back to the
per-action functions.

## Release B — removing the per-action functions

Only when nothing calls them. Check each one's request count in Cloud Monitoring
(`run.googleapis.com/request_count`, per service) over at least 14 days, and
confirm the oldest Android build in use ships `callable.js`. Then delete the
exports and the capacity test's "still deployed under its own name" check, which
exists to stop exactly this deletion until then. That frees ~4.17 vCPU.
