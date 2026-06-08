/**
 * cloudinaryService.js
 *
 * Single integration point for all Cloudinary operations across
 * admin, artisan, and customer apps.
 *
 * SETUP:
 *   1. Replace CLOUD_NAME with your Cloudinary cloud name.
 *   2. Create the four upload presets listed in UPLOAD_PRESETS
 *      in your Cloudinary dashboard (Settings → Upload → Upload presets).
 *   3. Import cdnUrl / uploadImage wherever images are displayed or uploaded.
 *
 * RULE: Always store public_id in Firestore — never the full URL.
 *       The URL is constructed at render time so you can change
 *       dimensions/format without touching the database.
 */

const CLOUD_NAME = 'dnwwglbl9';

const BASE = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload`;

/* ─────────────────────────────────────────────────────────────────
   UPLOAD PRESETS
   Must match exactly what you created in the Cloudinary dashboard.
   Settings → Upload → Upload presets → Add upload preset
───────────────────────────────────────────────────────────────── */
export const UPLOAD_PRESETS = {
  profile:   'hh_profiles',   // artisan + customer profile photos
  portfolio: 'hh_portfolio',  // artisan work/job photos
  banner:    'hh_banners',    // admin promotional banners
  job:       'hh_jobs',       // job-site photos uploaded during booking
  icon:      'hh_icons',      // service category icons (admin only)
};

/* ─────────────────────────────────────────────────────────────────
   TRANSFORMATION PRESETS
   f_auto  → delivers WebP / AVIF based on browser, JPEG as fallback
   q_auto  → intelligent compression, no visible quality loss
   c_fill  → crop to exact dimensions, preserving aspect ratio
   r_max   → circular crop (avatars)
───────────────────────────────────────────────────────────────── */
export const TRANSFORMS = {
  avatarLg:  'w_160,h_160,c_fill,f_auto,q_auto,r_max',  // artisan profile card
  avatarSm:  'w_80,h_80,c_fill,f_auto,q_auto,r_max',    // list / sidebar
  avatarXs:  'w_44,h_44,c_fill,f_auto,q_auto,r_max',    // chat / notification
  card:      'w_320,h_220,c_fill,f_auto,q_auto',         // artisan search card
  portfolio: 'w_600,h_400,c_fill,f_auto,q_auto',         // portfolio detail view
  thumb:     'w_160,h_120,c_fill,f_auto,q_auto',         // portfolio grid thumb
  banner:    'w_800,h_440,c_fill,f_auto,q_auto',          // dashboard ad banners
  icon:      'w_64,h_64,c_fill,f_auto,q_auto',           // service category icons
  job:       'w_480,h_360,c_fill,f_auto,q_auto',         // job-site photos
  full:      'f_auto,q_auto',                             // full size, optimized only
};

/* ─────────────────────────────────────────────────────────────────
   cdnUrl(publicId, transform?, version?)
   Constructs a Cloudinary delivery URL from a stored public_id.

   version (number) — the integer returned by Cloudinary on upload,
   stored as profileImageVersion in Firestore.  Including it in the
   URL produces a distinct cache entry per upload, so re-uploading
   the same public_id never serves a stale image from the CDN or
   the browser HTTP cache.  Accounts with no version get the plain
   URL (backward-compatible).

   URL shape:
     with version:  /image/upload/v{version}/{transform}/{publicId}
     without:       /image/upload/{transform}/{publicId}
───────────────────────────────────────────────────────────────── */
export function cdnUrl(publicId, transform = '', version = null) {
  if (!publicId) return null;
  const v = version ? `v${version}/` : '';
  return transform
    ? `${BASE}/${v}${transform}/${publicId}`
    : `${BASE}/${v}${publicId}`;
}

/* ─────────────────────────────────────────────────────────────────
   uploadImage(file, preset, options?)
   Uploads a File directly to Cloudinary using an unsigned preset.
   Returns the public_id — this is what you store in Firestore.

   The file never passes through your backend.
   Cloudinary handles storage, CDN distribution, and transformation caching.

   Example:
     const publicId = await uploadImage(
       fileInputEl.files[0],
       UPLOAD_PRESETS.profile,
       { publicId: `artisan_${uid}` }
     );
     await updateDoc(artisanRef, { profileImageId: publicId });
───────────────────────────────────────────────────────────────── */
export async function uploadImage(file, preset, { publicId = '' } = {}) {
  if (!file) throw new Error('No file provided');
  if (!preset) throw new Error('No upload preset provided');

  const MAX_MB = 10;
  if (file.size > MAX_MB * 1024 * 1024) {
    throw new Error(`File exceeds ${MAX_MB}MB limit`);
  }

  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED.includes(file.type)) {
    throw new Error('Only JPEG, PNG, WebP, and GIF images are allowed');
  }

  const body = new FormData();
  body.append('file', file);
  body.append('upload_preset', preset);
  if (publicId) body.append('public_id', publicId);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: 'POST', body }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Upload failed (${res.status})`);
  }

  const data = await res.json();
  // Return both public_id and version.
  // version is stored as profileImageVersion in Firestore and embedded in
  // the CDN URL so each upload gets a distinct browser/CDN cache entry.
  return { publicId: data.public_id, version: data.version ?? null };
}

/* ─────────────────────────────────────────────────────────────────
   uploadWithProgress(file, preset, options?)
   Same as uploadImage but fires an onProgress(percent) callback.
   Use for portfolio uploads where progress feedback matters.

   Example:
     const publicId = await uploadWithProgress(
       file,
       UPLOAD_PRESETS.portfolio,
       {
         publicId: `job_${bookingId}_1`,
         onProgress: (pct) => progressBar.style.width = pct + '%',
       }
     );
───────────────────────────────────────────────────────────────── */
export function uploadWithProgress(file, preset, { publicId = '', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file provided'));

    const body = new FormData();
    body.append('file', file);
    body.append('upload_preset', preset);
    if (publicId) body.append('public_id', publicId);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        resolve({ publicId: data.public_id, version: data.version ?? null });
      } else {
        const err = JSON.parse(xhr.responseText);
        reject(new Error(err.error?.message ?? `Upload failed (${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`);
    xhr.send(body);
  });
}

/* ─────────────────────────────────────────────────────────────────
   FALLBACK AVATAR
   Returns a UI Avatars URL when no profileImageId is set.
   Safe to use anywhere as a placeholder.
───────────────────────────────────────────────────────────────── */
export function fallbackAvatar(name = '') {
  const initials = name.trim().split(/\s+/).filter(Boolean).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  const fs  = initials.length > 1 ? 14 : 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#730201"/><text x="20" y="20" font-family="Arial,sans-serif" font-size="${fs}" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="central">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ─────────────────────────────────────────────────────────────────
   resolveAvatar(data, transform?)
   Single source-of-truth for avatar resolution across the whole app.

   Handles the two-generation field naming:
     • profileImageId  — Cloudinary public_id (all new uploads)
     • profileImage    — legacy full URL (pre-migration accounts)
     • fallback        — generated initials avatar

   Use this everywhere instead of reading profileImage or profileImageId
   directly, so the app stays consistent regardless of account age.
───────────────────────────────────────────────────────────────── */
export function resolveAvatar(data, transform = TRANSFORMS.avatarSm) {
  if (!data) return fallbackAvatar('');
  if (data.profileImageId)
    return cdnUrl(data.profileImageId, transform, data.profileImageVersion ?? null);
  if (data.profileImage) return data.profileImage;
  return fallbackAvatar(data.name || '');
}
