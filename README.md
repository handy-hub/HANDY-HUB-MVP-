# HandyHub MVP

A multi-app service platform (customers book artisans). Plain HTML/CSS/ES-module
JS served as static sites, backed by Firebase (Auth, Firestore, Hosting, Cloud
Functions). No build framework — but there **is** a small deploy staging step
(see "Deploy" below).

---

## Folder map — what to edit vs. what's generated

> **The #1 confusion to avoid:** `customer-app/` and `build-customer-app/` are
> NOT duplicates. One is source (you edit it); the other is generated output
> (you never edit it). Same for the artisan pair. Think `src/` vs `dist/`.

### ✅ Source — these are the real code; EDIT THESE
| Folder | What it is |
|---|---|
| `customer-app/` | The customer-facing app (login, signup, dashboard, booking, wallet, profile…). |
| `artisan-app/` | The artisan-facing app (jobs, bookings, earnings, profile, settings…). |
| `shared/` | Shared CSS tokens, JS (DI container, repositories, services), assets used by **both** apps. Pages reference it as `../shared/...`. |
| `functions/` | Firebase Cloud Functions (server-side: payments, escrow, AI search…). |
| `admin-dashboard/` | Internal admin tools (verifications, disputes). Not currently deployed via this project's hosting. |
| `dataconnect/` | Firebase Data Connect schema/config. |
| `scripts/` | Repo tooling — notably `stage-hosting.cjs` (the deploy staging script). |
| `tests/` | Python audit scripts (codebase/security audits). |

### 🤖 Generated — DO NOT EDIT (changes get overwritten); gitignored
| Folder | What it is |
|---|---|
| `build-customer-app/` | Staged copy of `customer-app/` **+ a bundled `shared/`**, arranged so production paths resolve. Created by `scripts/stage-hosting.cjs`. Firebase deploys **this**, not `customer-app/`. |
| `build-artisan-app/` | Same, for the artisan app. |

> **Why the build step exists:** pages reference `../shared/...` (one level *above*
> the app dir), which works locally because the dev server serves the repo root.
> But each Firebase Hosting site's root **is** the app dir, so `../shared/...`
> would escape the root and 404 in production. The stage script mirrors the local
> sibling layout (`build-<app>/<app>/` + `build-<app>/shared/`) so paths resolve
> identically — with zero page edits.

### 🧹 Misc
- `web-app/` — appears orphaned (only a stray README). Candidate for removal.
- `node_modules/`, `skills/` — dependencies / tooling, not app code.

---

## Develop locally
Serve the **repo root** (so `../shared/...` resolves):
```
npx serve .       # or: python -m http.server
```
Then open `customer-app/login.html` / `artisan-app/login.html`, etc.

## Deploy
The `build-*` folders must be regenerated from source **before** every deploy,
or production ships a stale build:
```
node scripts/stage-hosting.cjs customer-app
node scripts/stage-hosting.cjs artisan-app
firebase deploy --only hosting
```
Hosting targets (see `.firebaserc` / `firebase.json`):
- `customer` → site `lamax-4fd82`  → https://lamax-4fd82.web.app
- `artisan`  → site `lamax-artisan` → https://lamax-artisan.web.app

> ⚠️ Because staging is a manual step, it's easy to forget. Consider an
> `npm run deploy` script that runs both stage commands then `firebase deploy`.

## Design system
The customer app's canonical design tokens live in
`shared/css/ui-polish.css` — see `customer-app/css/DESIGN-SYSTEM-CONTRACT.md`.
The artisan app's design system is `artisan-app/css/design-system.css`.
