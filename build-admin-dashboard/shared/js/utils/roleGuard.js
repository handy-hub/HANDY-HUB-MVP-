/**
 * roleGuard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CENTRALIZED ROLE-BASED ACCESS CONTROL (RBAC) — single source of truth for
 * resolving *which application role* a Firebase-authenticated UID is allowed to
 * act as. Every application boundary (customer authGuard, artisan authGuard,
 * and both login/provisioning flows) MUST derive role from this module — never
 * from localStorage, a URL parameter, a hidden field, or any client-declared
 * value.
 *
 * ── Architectural principle: Authentication ≠ Authorization ──────────────────
 * A valid Firebase email/password only proves *identity*. It never proves that
 * the identity is permitted to enter a given application. HandyHub has three
 * mutually-exclusive application roles, each keyed by the existence of a
 * Firestore document under the caller's own UID:
 *
 *     artisans/{uid}   → ARTISAN   (HandyHub Pro app)
 *     customers/{uid}  → CUSTOMER  (Customer app)
 *     admins/{uid}     → ADMIN     (Admin dashboard; also super-admin emails)
 *
 * Role is authoritative on the SERVER: firestore.rules forbid a single UID from
 * ever owning both a customers/{uid} and an artisans/{uid} document (mutual
 * exclusivity on create). This client module mirrors that server truth so the
 * UI can fail fast and never render another application's surface.
 *
 * ── Fail-safe precedence ─────────────────────────────────────────────────────
 * If — through legacy data created before role isolation was enforced — a UID
 * somehow owns BOTH documents, the ARTISAN identity always wins. That keeps a
 * hybrid/legacy account OUT of the customer app (the reported vulnerability)
 * rather than silently granting cross-role access.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const ROLE = Object.freeze({
  CUSTOMER: 'customer',
  ARTISAN:  'artisan',
  ADMIN:    'admin',
  UNKNOWN:  'unknown',
});

function isRoleDoc(snap, expectedType) {
  return !!(snap && snap.exists && snap.data && snap.data.userType === expectedType);
}

/**
 * Resolve the authoritative application role for a UID by reading its role
 * documents. Reads customers/{uid} and artisans/{uid} in parallel.
 *
 * @param {{ getDocument: Function }} databaseService  DI container databaseService
 * @param {string} uid
 * @returns {Promise<{
 *   role: string, isArtisan: boolean, isCustomer: boolean,
 *   customer: object|null, artisan: object|null, readError: boolean
 * }>}
 *
 * `readError` is true only when BOTH reads threw (e.g. total network loss). It
 * lets a caller distinguish "definitely the wrong role" from "couldn't tell" so
 * it can choose to fail closed (deny) or degrade open (allow, relying on the
 * server rules backstop) as appropriate for that boundary.
 */
export async function resolveAppRole(databaseService, uid) {
  if (!databaseService || !uid) {
    return { role: ROLE.UNKNOWN, isArtisan: false, isCustomer: false, customer: null, artisan: null, readError: true };
  }

  let artisanErr = false;
  let customerErr = false;

  const [artisanSnap, customerSnap] = await Promise.all([
    databaseService.getDocument('artisans', uid).catch(() => { artisanErr = true; return null; }),
    databaseService.getDocument('customers', uid).catch(() => { customerErr = true; return null; }),
  ]);

  const isArtisan  = isRoleDoc(artisanSnap, ROLE.ARTISAN);
  const isCustomer = isRoleDoc(customerSnap, ROLE.CUSTOMER);

  // Fail-safe precedence: artisan identity wins so a legacy hybrid account can
  // never use the customer app.
  let role = ROLE.UNKNOWN;
  if (isArtisan) role = ROLE.ARTISAN;
  else if (isCustomer) role = ROLE.CUSTOMER;

  return {
    role,
    isArtisan,
    isCustomer,
    artisan:  isArtisan  ? artisanSnap.data  : null,
    customer: isCustomer ? customerSnap.data : null,
    readError: artisanErr && customerErr,
  };
}

/**
 * Convenience assertion used by the login/provisioning flow: throws if the UID
 * already belongs to an artisan, so the customer app never provisions a second
 * (customer) identity for an artisan account. The thrown error carries a stable
 * code the login/signup UIs map to friendly copy.
 *
 * @param {{ getDocument: Function }} databaseService
 * @param {string} uid
 * @param {'customer'|'artisan'} intendedRole  the app the caller is entering
 */
export async function assertNoCrossRole(databaseService, uid, intendedRole) {
  const info = await resolveAppRole(databaseService, uid);

  if (intendedRole === ROLE.CUSTOMER && info.isArtisan) {
    throw Object.assign(
      new Error('This is an artisan account. Please use the HandyHub Pro (artisan) app to sign in.'),
      { code: 'auth/wrong-app-role', actualRole: ROLE.ARTISAN }
    );
  }

  if (intendedRole === ROLE.ARTISAN && info.isCustomer) {
    throw Object.assign(
      new Error('This is a customer account. Please use the HandyHub Customer app to sign in.'),
      { code: 'auth/wrong-app-role', actualRole: ROLE.CUSTOMER }
    );
  }

  return info;
}
