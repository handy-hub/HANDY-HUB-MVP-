# Artisan account closure (AR-15, 2026-10-20)

Settings → **Close account** (artisan app) calls the existing
`checkAccountDeletable` / `requestAccountDeletion` callables, which now route an
artisan to `checkArtisanClosable` / `requestArtisanClosure` in
`functions/accountLifecycle.js`. Customers keep their existing path.

## Refused while anything is outstanding

| Blocker | Why |
|---|---|
| Available balance > 0 | The money is theirs; once the login is deleted nobody can withdraw it. Withdraw first. |
| A payout still in flight | It may fail and refund to the wallet. |
| Escrow held or disputed for their jobs | The customer or an administrator still has to decide it. |
| A booking not finished (`completed`, `cancelled`, `rejected`, `unfulfilled`, `resolved` are finished) | A customer is relying on the job. |
| An open job request | Answer it first. |

It also requires a **sign-in within the last 5 minutes**, checked on the server
from the ID token's `auth_time` (the app re-authenticates with the password, or
the Google popup, and refreshes the token immediately before calling).

## What happens

| Record | Outcome |
|---|---|
| `artisans/{uid}` | Kept as a tombstone (`deleted`, `status: 'closed'`); name, contact details, photo, bio, location, push token, search keywords, skills erased |
| `artisans/{uid}/private/location`, `artisan_index/{uid}` | Deleted — out of search and dispatch |
| Transactions, payouts, escrow, commissions, `financialAudit`, `verification_logs` | **Kept unchanged** |
| Bookings, reviews, chats, offer events | **Kept** — they are the customers' records too |
| `private/kyc`, `verification_requests/{uid}`, uploaded ID documents | **Kept**, administrators only, `accountClosedAt` stamped |
| Firebase Auth user | Deleted last |
| `financialAudit` | One `account_closed` entry |

## Decisions still needed (not made by the code)

1. **How long identity evidence is kept.** The Ghana Card number, TIN, date of
   birth, payout account and uploaded ID images underpin payouts already made.
   A retention period (and who confirms it — legal / the payments provider's
   requirements) is needed before a purge job is written. Until then nothing is
   purged automatically; an administrator can still read the records.
2. **The profile photo on Cloudinary** is not deleted (only its reference is).
   Deleting it needs the existing photo-cleanup path (`profilePhotos.js`) to be
   extended to closed accounts.
3. **The name stamped on past bookings** (`artisanName`) stays, as part of the
   customer's job history.
4. The customer path does not yet require a recent sign-in on the server (it
   re-authenticates on the client). Applying the same `auth_time` check there is
   a small follow-up.
