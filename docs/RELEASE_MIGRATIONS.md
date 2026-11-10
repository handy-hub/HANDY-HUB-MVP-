# Release migrations — runbook

Prepared 2026-11-10 for the release of `feat/artisan-design-system`.
**None of these has been run against production.** Each step that touches
production needs the owner's explicit approval, given separately from the
approval to deploy.

Two admin callables carry three one-off migrations that move private data
off documents every signed-in account can read. The code that wrote that data has already
stopped writing it (in this release); these move the copies already there.

| # | Callable | Moves | Code |
|---|---|---|---|
| M1 | `adminMigrateArtisanPrivateData` | identity, payout and contact details; old decision records | `functions/artisanPrivacy.js` |
| M2 | `adminMigrateContactPrivacy` | artisans' precise positions; phone numbers on bookings; starts the 14-day clock on old closed bookings | `functions/contactPrivacy.js`, `functions/locationRetention.js` |

(The decision-record cleanup is a step of M1, not a third function, to stay
inside the Cloud Run CPU budget.)

## Shared contract

Both callables:

- Refuse anyone but a **verified** allow-listed super-admin (`isAllowlistedAdmin`).
- Take `{ mode }`, which can be:
  - `dry-run` (the default) reports and writes nothing.
  - `copy` fills the private record and never overwrites a value already there.
  - `strip` copies anything still missing, then removes the public copy, one
    document per transaction, and only once the private record holds the value.
- Are safe to repeat: a second `strip` finds nothing.
- Report ids, counts and **field names only, never values**.
- Run for up to 540 s per call, 200 documents a page.

## Before anything

1. Deploy this release (functions first, see `docs/RELEASE.md`). The
   migrations must run on the deployed code, not an older one.
2. **Backup.** Export the named database so any document can be restored to
   its exact pre-migration state:
   ```
   gcloud firestore export gs://<backup-bucket>/pre-migration-2026-11 \
     --project=lamax-4fd82 --database=ai-studio-5589039d-72c4-40d8-ae39-f35c6c321eb6
   ```
   The bucket must exist and the Firestore service agent must be able to
   write to it. Note the export path in the release notes. (Production
   action: needs approval.)
3. Open the admin dashboard, signed in as a verified super-admin. In the
   browser console:
   ```js
   const { callAdminFunction } = await import('/admin-dashboard/js/firebase-admin.js');
   const run = async (name, mode) => (await callAdminFunction(name, { mode })).data;
   ```

## M1 — artisan identity, payout, contact and decision records

**Current structure.** `artisans/{id}` is readable by every signed-in
account. Older profiles can still carry the following fields.

- Identity: `ghanaCardNumber`, `tin`, `dob`, `dateOfBirth`, `businessRegNumber`.
- Payout: `payoutAccount`, `momoProvider`, `momoPhone`, `momoAccountName`.
- Home: `address`, `gpsAddress`, `emergencyContact`.
- Contact (CONTACT-001): `phone`, `email`, `phoneNumber`, `contactEmail`, `whatsapp`.
- Decision records:
  - Reasons: `rejectionReason`, `banReason`, `suspensionReason`.
  - The deciding admin's email: `approvedBy`, `rejectedBy`, `suspendedBy`,
    `reinstatedBy`, `bannedBy`, `unbannedBy`.
  - Internal review fields: `reviewedBy`, `adminNotes`, `trustScore`.

**Expected changes.**

- Identity, payout and home fields go to `artisans/{id}/private/kyc`.
- Contact fields go to `artisans/{id}/private/contact`. A value that is not a
  valid phone or email, or a second number, goes to `private/contactLegacy`.
- Decision records go to `verification_requests/{id}`. An artisan with no
  request gets `artisans/{id}/private/decisionLegacy` instead, so no request
  is created and nobody re-enters the review queue.
- A value already in the destination wins; the stale public copy is still
  removed and reported as a conflict.
- `isVerified` and the decision timestamps (`approvedAt`, `bannedAt`, …)
  stay public.

**Records affected.** Unknown until the production dry run: the dry run *is*
the count (`scanned`, `affected`, and per artisan the field names).

**Procedure.**
1. `await run('adminMigrateArtisanPrivateData', 'dry-run')`. Save the report.
2. `await run('adminMigrateArtisanPrivateData', 'copy')`. Then open a few
   affected artisans in the admin dashboard and check the private details show.
3. `await run('adminMigrateArtisanPrivateData', 'strip')`.
4. `await run('adminMigrateArtisanPrivateData', 'strip')` again. It must report
   nothing affected.

**Verification.** In the step-4 report, no artisan is listed. Signed in as a
customer, read three of the affected profiles: none of the fields above is
present. The artisan's application screen still shows a past rejection
reason, now read from `verification_requests`.

**Rollback.** `copy` changes no public document. After `strip`, every
removed value exists in its private record (the tests prove the step is
lossless). To undo, restore the fields from the private records with a
reverse script, or re-import the affected documents from the step-2 export.
Prefer the export: it restores the exact documents.

## M2 — positions, booking phones, 14-day clock

**Current structure.**

- `artisans/{id}`: precise `currentLat`, `currentLng`, `locationAccuracy`,
  full-precision `lat`/`lng`/`latitude`/`longitude`, long `geohash`.
- `bookings/{id}`: `customerPhone`; the artisan's phone copied by older
  clients (`proPhone`, `artisanPhone`, `artisan.phone`, `professional.phone`).
- Bookings closed before decision Q6 have no `locationRetainUntilMs`, so their
  `address`, `lat`, `lng` and `notes` stay readable by the artisan for good.

**Expected changes.**

- Profiles: the precise position goes to `artisans/{id}/private/location`.
  The profile keeps a copy at about 1 km precision; precise fields become `null`.
- Bookings: phones go to `bookings/{id}/private/contact` and
  `private/artisanContact`.
- Old closed bookings are stamped `locationRetainUntilMs = closed + 14 days`.
  The hourly sweep (`checkBookingTimeouts`) then moves the exact location to
  `bookings/{id}/private/location` (customer and admin only) once that time
  has passed.

**Records affected.** The dry run reports
`artisans.exposed`, `bookings.exposed`, `artisanPhones.exposed` and the
bookings it would stamp.

**Procedure.** As M1: `dry-run`, `copy`, check, `strip`, `strip` again.

**Verification.**

- The second `strip` reports 0 exposed in every section.
- After the next hourly sweep, an artisan opening a job that closed more
  than 14 days ago sees that the address was removed, and the booking
  document itself no longer holds the address.

**Side effect to expect.** On the first hourly sweep after `strip`, every
booking closed more than 14 days ago loses its address from the booking
document at once. The address is not deleted: it moves to the private record.

**Rollback.** Profiles and phones: as M1, from the private records or the
export. The 14-day move: the private location record holds the moved fields,
and the export holds the originals. Restoring them puts the address back in
the artisan's reach, which is what Q6 decided against, so only do it to undo
a fault.

## Tested

- `npm run test:artisan-privacy` covers M1 on an in-memory database:
  every mode, conflicts, pages, nothing lost, no value in any report, who
  may run it.
- `npm run test:location-retention` and `tests/privacy-access.test.cjs`
  cover M2's parts.
- `npm run test:functions-emulator` runs both real callables in the
  emulator on seeded legacy data. It checks: refused to customers, artisans,
  anonymous callers and an unverified allow-listed email; dry run writes
  nothing; copy, then strip; nothing private left public; every value in
  its private home; bookings stamped from their close date; phones gone; a
  repeat finds nothing; no report carries a value. 39 checks; the
  migrations are 11 of them.
