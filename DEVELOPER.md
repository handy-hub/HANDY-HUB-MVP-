# HandyHub — Local Development Guide

## Quick Start (Development)

```bash
npm install      # installs serve (one-time)
npm run dev      # starts project-root server at http://localhost:8766
```

Then open:
- **Customer App** → http://localhost:8766/customer-app/login.html
- **Artisan App**  → http://localhost:8766/artisan-app/login.html
- **Admin Dashboard** → http://localhost:8766/admin-dashboard/

## Why serve from the project root?

All HTML pages reference shared assets with paths like `../shared/js/...` and
`../shared/assets/...`. These paths resolve correctly **only** when the server
root is the project root, exactly as Firebase Hosting serves the project.

**Do not** run `python -m http.server` from inside `customer-app/` — the
`../shared/` imports will 404 and the app will partially break.

## Correct local URL structure (port 8766)

```
http://localhost:8766/
  ├── customer-app/   ← customer-facing pages
  ├── artisan-app/    ← artisan-facing pages
  ├── admin-dashboard/← admin pages
  └── shared/         ← shared JS / CSS / assets (resolved via ../ from pages)
```

## Running the Verification Tests

The Playwright test suite (`tests/verify_low_fixes.py`) requires **two servers**
running simultaneously before you execute it:

| Port | Command | Purpose |
|------|---------|---------|
| 8765 | `npm run serve:ca` | Serves `customer-app/` as root — used by page-title, logo fallback, and regression tests |
| 8766 | `npm run dev`      | Serves project root — used by asset-path and shared-module tests |

```bash
# Terminal 1
npm run serve:ca   # http://localhost:8765/ → customer-app/

# Terminal 2
npm run dev        # http://localhost:8766/ → project root

# Terminal 3
npm test           # python tests/verify_low_fixes.py
```

## Firebase Hosting

Production deployment uses `firebase deploy`.
The `firebase.json` hosting config and `.firebaserc` project ID are already set up.
Run `firebase serve` as an alternative local dev server (also serves from root).

## Playwright Testing

```bash
# Run smoke tests (requires npm run dev in another terminal on port 8766)
python tests/smoke_test.py

# Run low-priority fix verification (requires both servers — see above)
npm test

# Run full audit
python tests/audit_phase1.py
```

## Notes

- All Firestore operations require a Firebase project connection. Local dev shows
  empty states for authenticated data (expected).
- Leaflet maps load from CDN (unpkg.com) — internet connection required locally.
- The `functions/` directory contains Cloud Functions deployed via
  `firebase deploy --only functions`.
