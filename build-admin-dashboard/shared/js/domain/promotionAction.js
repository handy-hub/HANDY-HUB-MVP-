/**
 * promotionAction.js — THE single contract for what a promotion "action" means.
 * ─────────────────────────────────────────────────────────────────────────────
 * One canonical definition of, for each supported action type:
 *   • where a tap goes in the Customer App (the destination URL),
 *   • what session context it sets before navigating,
 *   • whether the value is valid enough to publish.
 *
 * Both sides import this so they can never disagree:
 *   • Customer App  — adBanner.js `resolveAction()` executes this contract.
 *   • Admin App     — promotions.html validates + previews against it.
 *
 * Stored schema (promotions/{id}.action): { type, value } — a single string value.
 * `resolveCategory()` accepts a category id, label, or key (serviceCatalog.js).
 *
 * Route history note: `book-step1.html` was removed in the booking rebuild; the
 * canonical booking entry point is `book-request.html` (a category opens
 * `book-request.html?cat=<id>`, exactly how the dashboard opens a category).
 * The old `category` destination `browse.html` never existed and is gone.
 */

import { resolveCategory } from '../data/serviceCatalog.js';

export const PROMO_ACTION_TYPES = ['service', 'artisan', 'route', 'external', 'promo', 'category'];

/** Canonical internal routes a `route` action may target (the route registry). */
export const CUSTOMER_ROUTES = [
  'book-request.html', 'professionals.html', 'services.html', 'topup.html',
  'saved.html', 'notification.html', 'profile.html', 'settings.html',
  'messages.html', 'transaction-history.html', 'dashboard.html', 'book-emergency.html',
];

const BOOK = 'book-request.html';   // canonical booking entry point

/**
 * Is `value` a usable target for `type`? Used by the admin editor to BLOCK saving
 * a known-dead or unsafe destination, and internally to fall a bad value back safely.
 * @returns {boolean}
 */
export function isValidPromotionActionValue(type, value) {
  const v = (value ?? '').toString().trim();
  if (!v) return false;
  switch (type) {
    case 'route':    return CUSTOMER_ROUTES.includes(v);          // only known internal routes (rejects book-step*, deleted files)
    case 'external': return /^https?:\/\/\S+$/i.test(v);          // http(s) only — rejects javascript:/data:/malformed
    case 'service':
    case 'category': return !!resolveCategory(v);                 // must resolve to a real catalog category
    case 'artisan':  return true;                                 // non-empty id (existence not checked client-side)
    case 'promo':    return true;                                 // non-empty code
    default:         return false;
  }
}

/**
 * Resolve a promotion action to its canonical destination + side effects.
 * PURE — performs no navigation and no storage writes; the caller does that.
 * A missing/invalid value degrades to the booking entry point rather than a dead link.
 * @param {{type:string, value:string}} action
 * @returns {{ url:string, newTab:boolean, session:Object<string,string> }}
 */
export function promotionActionTarget(action) {
  const type  = action?.type;
  const value = (action?.value ?? '').toString().trim();

  switch (type) {
    // service + category both open the category's discovery/booking page
    // (book-request.html?cat=<id>) — `service` resolves a service NAME, `category`
    // a category identifier. Both go through resolveCategory().
    case 'service':
    case 'category': {
      const cat = resolveCategory(value);
      return {
        url: cat ? `${BOOK}?cat=${encodeURIComponent(cat.id)}` : BOOK,
        newTab: false,
        session: value ? { hh_service: value } : {},
      };
    }
    case 'artisan':
      return {
        url: 'artisan-profile.html',
        newTab: false,
        session: value ? { hh_artisan_view: JSON.stringify({ id: value }) } : {},
      };
    case 'route':
      return { url: isValidPromotionActionValue('route', value) ? value : BOOK, newTab: false, session: {} };
    case 'external': {
      const ok = isValidPromotionActionValue('external', value);
      return { url: ok ? value : BOOK, newTab: ok, session: {} };
    }
    case 'promo':
      // Meaning (enforced): store the code, then open the booking entry point.
      return { url: BOOK, newTab: false, session: value ? { hh_promo: value } : {} };
    default:
      return { url: BOOK, newTab: false, session: {} };
  }
}

/** Short human description of where a tap goes — for the admin editor's preview/hint. */
export function describePromotionActionDestination(action) {
  const t = promotionActionTarget(action);
  return t.newTab ? `Opens ${t.url} in a new tab` : `Opens ${t.url}`;
}
