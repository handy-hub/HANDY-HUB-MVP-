# HandyHub Scalable Architecture

This project now uses a clean layered architecture so backend providers can be swapped with minimal changes.

## Layer Map

### UI Layer
- `customer-app/`
- `artisan-app/`
- `shared/js/ui/`

Responsibilities:
- DOM handling
- page event wiring
- rendering and navigation

Rules:
- UI never imports Firebase SDK directly.
- UI calls domain services via the app container.

### Services / Business Layer (Domain)
- `shared/js/domain/services/`

Responsibilities:
- business rules (signup/login/session flow)
- validation and orchestration
- error mapping at use-case boundaries

Rules:
- Domain depends on repositories only.
- Domain never imports Firebase SDK.

### Repository / Data Layer
- `shared/js/data/repositories/`

Responsibilities:
- translate domain requests into data operations
- keep collection/query details outside UI/domain

Rules:
- Repositories depend on backend service contracts.
- No direct UI logic.

### Backend Provider Layer
- `shared/js/backend/`
- `shared/js/backend/providers/firebase/`

Responsibilities:
- implement `AuthService`, `DatabaseService`, `StorageService`, `NotificationService`
- isolate all provider SDK calls

Rules:
- This is the only location with direct Firebase SDK imports.

## DI / Provider Selection

- `shared/js/app/backendProviderFactory.js` selects the backend provider (`firebase` today).
- `shared/js/app/container.js` composes provider services, repositories, and domain services.
- UI gets ready-to-use services from `getAppContainer()`.

## Firebase Replacement Guide

If Firebase is replaced, the primary files to change are:

1. `shared/js/backend/providers/firebase/firebaseConfig.js`
2. `shared/js/backend/providers/firebase/firebaseAuthService.js`
3. `shared/js/backend/providers/firebase/firebaseDatabaseService.js`
4. `shared/js/backend/providers/firebase/firebaseStorageService.js`
5. `shared/js/backend/providers/firebase/firebaseNotificationService.js`
6. `shared/js/backend/providers/firebase/index.js`
7. `shared/js/app/backendProviderFactory.js` (wire the new provider key)

Everything else (UI/domain/repositories) can remain unchanged if the new provider honors the same service contracts.

## Multi-App Readiness

Current and future app boundaries are now explicit:

- Customer UI: `customer-app/` + `shared/js/ui/customer/`
- Artisan UI: `artisan-app/` + `shared/js/ui/artisan/`
- Admin placeholder: `admin-dashboard/` + `shared/js/ui/admin/`
- Future web placeholder: `web-app/` + `shared/js/ui/web/`

