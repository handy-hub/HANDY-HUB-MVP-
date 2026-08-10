# Profile photo lifecycle

## Audit result

The customer profile, artisan profile, and artisan onboarding pages previously uploaded directly to Cloudinary and then wrote `profileImageId` from the browser. Each used a timestamp public ID, so replacement left the old asset permanently stored. The canonical implementation is now `shared/js/services/profilePhotoService.js`, backed by `functions/profilePhotos.js`.

Avatar rendering remains unchanged: Firestore stores `profileImageId` and `profileImageVersion`, and `cloudinaryService.resolveAvatar`/`avatarUrl` construct versioned delivery URLs. Legacy `profileImage` URLs and generated fallback avatars continue to render.

## Replacement protocol

1. `beginProfilePhotoReplacement` authenticates the caller, verifies the selected customer/artisan document, captures its authoritative current image metadata, allocates a random operation and Cloudinary public ID, and stores both server-side.
2. The browser uploads to that exact allocated ID through the existing unsigned profile preset.
3. `commitProfilePhotoReplacement` performs a Firestore compare-and-swap transaction. A concurrent replacement whose snapshot is stale is rejected and its new upload is cleaned up.
4. Only after Firestore points at the new asset does the backend delete the prior owned asset with Cloudinary's signed destroy API and cache invalidation.
5. Upload/commit failures call `abortProfilePhotoReplacement`; the backend obtains the candidate ID from its operation record, never directly from client deletion input.

New assets use `customers/{uid}/profile/*` or `artisans/{uid}/profile/*`. Deletion accepts those paths plus the pre-existing safe `customers/{uid}/{timestamp}` and `artisans/{uid}/{timestamp}` assets so the first replacement also removes historical storage. Default images, legacy external URLs, missing IDs, traversal-like IDs, and another user's assets are skipped. Client Firestore rules no longer permit direct writes to the two canonical metadata fields.

## Failure recovery and operations

Failed Cloudinary deletions are persisted in `_cloudinary_cleanup_jobs`. `retryProfilePhotoCleanup` processes up to 50 jobs every 30 minutes with exponential backoff; after eight failures the job remains marked `manual_review` for operator inspection. Cloudinary credentials remain server-only in the existing Functions environment variables:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Set the API credentials with `firebase functions:secrets:set CLOUDINARY_API_KEY` and `firebase functions:secrets:set CLOUDINARY_API_SECRET`; keep the non-secret cloud name in the Functions environment. Deploy Functions and Firestore rules together. Confirm the `hh_profiles` unsigned preset honors the supplied public ID and is restricted to accepted image formats and size limits in Cloudinary.
