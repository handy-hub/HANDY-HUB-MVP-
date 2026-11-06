/**
 * artisan-app/js/artisanLists.js — the live lists Today and Jobs both show,
 * defined once (Phase 3).
 *
 * The same query, the same instantView key and the same fields kept out of
 * storage on both screens: a booking Today has already loaded paints at once on
 * Jobs (and back), from one cache entry, and the two can never disagree about
 * which bookings exist. Each screen keeps its own handling of an outage.
 */
import { ACTIVE_STATUSES, HISTORY_STATUSES } from '../../shared/js/domain/artisanJobs.js';

/** The artisan's bookings that are still going (Today: the job and its lists; Jobs: Current and Upcoming). */
export const ACTIVE_LIST = Object.freeze({
    key: 'artisan-dashboard-active',
    version: 1,
    // Neither screen draws the customer's contact details or location from the
    // cache; the job screen reads them live. A disputed booking is included so
    // it reads "In dispute", not missing.
    stripFields: Object.freeze(['customerPhone', 'customerName', 'customerFullName', 'customerFirstName', 'customerEmail',
                                'customerId', 'address', 'lat', 'lng', 'notes']),
});
export function activeQuery(uid) {
    return ['bookings',
        [{ field: 'artisanId', op: '==', value: uid },
         { field: 'status',    op: 'in', value: [...ACTIVE_STATUSES] }],
        { orderBy: { field: 'updatedAt', direction: 'desc' }, limit: 50 }];
}

/** The artisan's open offers (the offer summary, never the booking). */
export const OFFERS_LIST = Object.freeze({
    key: 'artisan-dashboard-offers',
    version: 1,
    // Neither screen shows who or where an offer is from.
    stripFields: Object.freeze(['customerFirstName', 'lat', 'lng']),
});
export function offersQuery(uid) {
    return ['job_offers',
        [{ field: 'artisanId', op: '==', value: uid }, { field: 'offerStatus', op: '==', value: 'open' }],
        { limit: 5 }];
}

/** Closed bookings, newest first, a page at a time. `statuses` narrows a filter. */
export const HISTORY_PAGE = 20;
export const HISTORY_LIST = Object.freeze({
    key: 'artisan-jobs-history',
    version: 1,
    // History never shows contact details or the address (removed 14 days after
    // closing, decision Q6).
    stripFields: ACTIVE_LIST.stripFields,
});
export function historyQuery(uid, { statuses = HISTORY_STATUSES, after = null } = {}) {
    const opts = { orderBy: { field: 'updatedAt', direction: 'desc' }, limit: HISTORY_PAGE };
    if (after) opts.startAfter = after;
    return ['bookings',
        [{ field: 'artisanId', op: '==', value: uid },
         { field: 'status',    op: 'in', value: [...statuses] }],
        opts];
}
