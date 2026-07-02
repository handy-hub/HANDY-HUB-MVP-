/**
 * bookingStatusMeta.js
 *
 * Single source of truth for how a booking status is DISPLAYED.
 * The status vocabulary itself lives in bookingRepository.js (VALID_STATUSES) —
 * this module only maps that vocabulary onto UI concerns: label, status-pill
 * class, which tab/group a status belongs to, and (for statuses with an
 * active job in progress) a progress-bar percentage + phase label.
 *
 * Any page rendering a booking status (customer bookings list, artisan jobs
 * list, artisan bookings list, admin dashboards) must import from here rather
 * than re-declaring its own status → label/class map.
 */

// ── Tab / group membership ───────────────────────────────────────────────────
// Which top-level tab a given VALID_STATUSES entry belongs to.
export const TAB_STATUSES = {
    upcoming:  ['pending', 'dispatching', 'searching', 'dispatched', 'assigned'],
    ongoing:   ['accepted', 'en_route', 'in_progress', 'awaiting'],
    completed: ['completed'],
    cancelled: ['cancelled', 'rejected', 'unfulfilled'],
};

// ── Status → { label, cls } ──────────────────────────────────────────────────
// `cls` is a semantic suffix (upcoming|ongoing|completed|cancelled) consumed
// as `bk-status-${cls}` / `pill-${cls}` etc. by page-local CSS so each page
// can theme the same four semantic buckets without forking the vocabulary.
export const STATUS_META = {
    pending:      { label: 'Pending',      group: 'upcoming'  },
    dispatching:  { label: 'Dispatching',  group: 'upcoming'  },
    searching:    { label: 'Searching',    group: 'upcoming'  },
    dispatched:   { label: 'Dispatching',  group: 'upcoming'  },
    assigned:     { label: 'Assigned',     group: 'upcoming'  },
    accepted:     { label: 'Accepted',     group: 'ongoing'   },
    en_route:     { label: 'En Route',     group: 'ongoing'   },
    in_progress:  { label: 'In Progress',  group: 'ongoing'   },
    awaiting:     { label: 'Awaiting',     group: 'ongoing'   },
    completed:    { label: 'Completed',    group: 'completed' },
    cancelled:    { label: 'Cancelled',    group: 'cancelled' },
    rejected:     { label: 'Declined',     group: 'cancelled' },
    unfulfilled:  { label: 'Unmatched',    group: 'cancelled' },
};

// ── Progress bar % + phase label for "ongoing" statuses ──────────────────────
export const ACTIVE_PROGRESS = {
    accepted:    { pct: 15, label: 'Booking Accepted'      },
    en_route:    { pct: 40, label: 'Artisan En Route'      },
    in_progress: { pct: 70, label: 'Job In Progress'       },
    awaiting:    { pct: 90, label: 'Awaiting Confirmation' },
};

/** Returns { label, group } for a status, falling back to Pending/upcoming for unknown values. */
export function getStatusMeta(status) {
    return STATUS_META[(status || '').toLowerCase()] || { label: status || 'Pending', group: 'upcoming' };
}

/** Returns the tab/group name ('upcoming'|'ongoing'|'completed'|'cancelled') a status belongs to. */
export function getStatusGroup(status) {
    return getStatusMeta(status).group;
}

/** Returns { pct, label } progress info for an ongoing status, or a generic fallback. */
export function getActiveProgress(status) {
    return ACTIVE_PROGRESS[(status || '').toLowerCase()] || { pct: 10, label: 'Processing' };
}

/**
 * Whether a booking in this status can still be cancelled by the customer.
 * Mirrors the "upcoming" group — once dispatch has produced an active job
 * (ongoing) or the booking has already reached a terminal state, cancellation
 * is no longer a swipe-away UI action (it goes through tracking/support flows).
 */
export function isCancellable(status) {
    return getStatusGroup(status) === 'upcoming';
}
