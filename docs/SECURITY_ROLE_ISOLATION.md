# SECURITY PRINCIPLE — Role Isolation & Application Boundary Enforcement

**Status:** PERMANENT ENGINEERING STANDARD. Every contributor and every AI coding
agent MUST read and follow this before writing or modifying any authentication,
authorization, routing, login, signup, session, or Firestore-rules code.

**Owner:** Platform / Security
**Established:** 2026-07-14 (RBAC intervention closing the artisan→customer-app
cross-role login vulnerability)

---

## 1. The one rule that must never be broken

> **Authentication is NOT authorization.**
>
> A valid Firebase email/password (or social credential) proves *identity only*.
> It never, by itself, grants access to an application, a page, a component, or a
> piece of protected data. Every application boundary MUST independently verify
> that the authenticated identity holds the **role** required for that boundary
> **before** any protected route, state, or data initializes.

HandyHub has three **mutually exclusive** application roles. A single Firebase UID
may hold **exactly one** of them:

| Role       | App               | Authoritative marker (per UID)            |
|------------|-------------------|-------------------------------------------|
| `customer` | Customer app      | `customers/{uid}` doc, `userType:'customer'` |
| `artisan`  | HandyHub Pro app  | `artisans/{uid}` doc, `userType:'artisan'`   |
| `admin`    | Admin dashboard   | `admins/{uid}` doc (or super-admin email)    |

**Cross-role authentication is prohibited.** A customer may access only the
Customer app; an artisan only the Artisan app; an admin only the Admin dashboard.
The same person who wants two roles must use two separate accounts (different
emails → different UIDs).

---

## 2. Why this exists (the vulnerability it closes)

Before this standard, the Customer app trusted Firebase authentication alone:

- `customer-app` route guard (`requireAuth`) checked only `if (user)` — **no role
  check**. Any authenticated Firebase user, including an artisan, passed.
- The customer login/social flow **auto-provisioned** a `customers/{uid}` document
  for whatever UID signed in (`ensureCustomerProfile`). An artisan logging into the
  Customer app was therefore *minted a second, customer identity* for their UID.
- Firestore rules enforced ownership but **not role exclusivity** — one UID could
  own both a `customers/{uid}` and an `artisans/{uid}` document.

Result: an artisan could sign into the Customer app with their artisan credentials
and operate as a customer (and, via a self-assigned booking, create self-dealing /
wash-trading fraud). The Cloud Functions / escrow layer was already sound; the gap
was entirely in the client auth layer plus the missing server exclusivity rule.

---

## 3. The mandatory flow

```
credentials
   → Firebase Authentication verifies IDENTITY
   → trusted role source verifies ROLE            (resolveAppRole: read role docs)
   → application verifies the role is PERMITTED    (customer app ⇒ role must be customer)
   → session initialized with verified authz context
   → protected routes become available
   → protected data loads
```

At **no** point may an authenticated-but-unauthorized user enter the app, briefly
render a protected page, fetch protected data, or initialize app state.

---

## 4. How it is enforced (defense in depth — every layer)

Role isolation is enforced at **four** independent layers. Never rely on only one.

### Layer 1 — Centralized role resolver (single source of truth)
`shared/js/utils/roleGuard.js`
- `resolveAppRole(databaseService, uid)` reads `artisans/{uid}` + `customers/{uid}`
  and returns the authoritative role. **Fail-safe precedence: artisan wins** so a
  legacy hybrid account can never use the Customer app.
- `assertNoCrossRole(...)` throws `auth/wrong-app-role` for a mismatch.
- **All** boundaries derive role from this module. Never read a role from
  localStorage, sessionStorage, a URL/route param, a hidden field, or any other
  client-declared value.

### Layer 2 — Route guards (block before render)
- Customer: `shared/js/utils/authGuard.js` `requireAuth()` — authenticates, then
  requires `role === 'customer'`. An artisan gets a blocking "Wrong App" overlay,
  is signed out, and is bounced to the Artisan app. Resolves **only** for customers.
- Artisan: `artisan-app/js/utils/artisanAuthGuard.js` `requireArtisanAuth()` —
  auth → `artisans/{uid}` exists → `userType==='artisan'` → status → KYC.
- Admin: `admin-dashboard/js/auth-guard.js` `initAdminPage()` — auth → super-admin
  email or `admins/{uid}` active.

### Layer 3 — Login / provisioning handlers (never mint a cross-role identity)
`shared/js/domain/services/customerAuthService.js`
- Before writing any `customers/{uid}` doc, `assertNotArtisan(uid)` runs. If the UID
  is an artisan, the session is signed out and `auth/wrong-app-role` is thrown.
- Applies to email login (`signInWithIdentifier`), all social paths
  (`ensureCustomerProfile`), and email signup.

### Layer 4 — Firestore Security Rules (the server backstop — cannot be bypassed)
`firestore.rules`
- `customers` create requires `!exists(artisans/{uid})`.
- `artisans` create requires `!exists(customers/{uid})`.
  → **Mutual exclusivity per UID, enforced from both directions.**
- `bookings` create requires `exists(customers/{request.auth.uid})` — only a genuine
  customer may create a booking (blocks artisan self-booking at the server).
- Cloud Functions independently re-verify the caller is the correct booking party
  (`functions/quotes.js`, `functions/pricing.js`: `preBooking.artisanId !== auth.uid`
  → not authorised), deriving authorization from `context.auth`, never from payload.

---

## 5. Rules for every future change (contributors & AI agents)

1. **Never trust a client-declared role.** Role comes only from `resolveAppRole` /
   the server role documents.
2. **Never add a route guard that checks only `if (user)`.** Every guard must verify
   the role for its application boundary.
3. **Never auto-provision a role document for a UID without first checking the UID
   does not already hold a different role.** Reuse `assertNoCrossRole` /
   `assertNotArtisan`.
4. **A new protected collection or Cloud Function must derive authorization from
   `request.auth.uid` / `context.auth`** and the server role docs — never from a
   request payload, and never from ownership alone when a role is implied.
5. **Roles stay mutually exclusive.** Do not add a code path or rule that lets one
   UID own two role documents. If a genuine dual-role product need ever arises, it
   must be designed explicitly (separate linked accounts), reviewed by Security, and
   this document updated first.
6. **Log out clears everything.** Sign-out must clear auth state and all uid-scoped
   client storage (`sessionService.logout`). Never leave a stale cached role.
7. **On token refresh / role change, re-derive role** — do not trust a cached role
   after permissions may have changed.

---

## 6. Regression test (keep it green)

`tests/rbac-role-isolation-audit.cjs` is an attacker-model test that proves the
server backstop using real Auth-emulator ID tokens against the Firestore emulator.
Run it after any change to `firestore.rules`, the auth flow, or the role docs:

```
firebase emulators:exec --only firestore,auth \
  --config firebase.rulescheck.json --project demo-handyhub \
  "node tests/rbac-role-isolation-audit.cjs"
```

Expected: `8 passed, 0 failed` (cross-role minting denied both ways;
artisan-as-customer booking denied; all legitimate signup/booking flows allowed).
