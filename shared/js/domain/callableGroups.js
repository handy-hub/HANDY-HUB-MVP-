// ─────────────────────────────────────────────────────────────────────────────
// callableGroups — which callable Cloud Functions are served by a group router.
//
// europe-west1 gives this project 20 vCPU of running Cloud Run instances, and
// with one small function per action that budget is spent (CLAUDE.md §4). A
// group router is ONE function with a full vCPU serving many requests at once,
// dispatching on `action` to the existing handler — same auth, rate limit,
// validation and errors. See functions/callableGroups.js.
//
// This list is the one source for both sides:
//   • the browser (shared/js/services/callable.js) sends a grouped action to
//     its router as { action, payload };
//   • the server (functions/index.js) builds each router from it — through the
//     generated mirror functions/shared/callableGroups.js.
//
// The per-action functions stay deployed: installed Android builds and cached
// pages still call them by name. They go in a later release, once nothing
// calls them (see docs/FUNCTION_GROUPS.md).
//
// Adding an action to a group is a client and server change in one: the
// router must be deployed before a client that sends it (the client falls
// back to the per-action function only when the router or action is missing).
// ─────────────────────────────────────────────────────────────────────────────

export const CALLABLE_GROUPS = Object.freeze({
    // A booking's life from fee to quote: pricing, the inspection track, the
    // offer, and the job quote.
    bookingActions: Object.freeze([
        'getPricingQuote',
        'createInspectionBooking',
        'payCalloutFee',
        'payEmergencyCallout',
        'completeInspection',
        'cancelInspectionBooking',
        'respondToJobOffer',
        'submitJobQuote',
        'approveJobQuote',
        'rejectJobQuote',
        'tipArtisan',
    ]),
    // The wallet: PIN, top-ups and withdrawals. Every credit still settles
    // through settleTopupByReference — the router adds no money path.
    walletActions: Object.freeze([
        'setSecurityPin',
        'initiateTopupCharge',
        'verifyTopupNow',
        'submitTopupOtp',
        'processWithdrawal',
        'processArtisanWithdrawal',
    ]),
});

/**
 * Actions that exist ONLY inside their router — added after grouping, so no
 * installed app ever called them by name and no per-action function is
 * deployed for them (that would spend CPU quota for nothing). The client never
 * falls back to calling these directly.
 */
export const ROUTER_ONLY = Object.freeze(['tipArtisan']);

/** The router serving `name`, or null when it is called by its own name. */
export function groupOf(name) {
    for (const group of Object.keys(CALLABLE_GROUPS)) {
        if (CALLABLE_GROUPS[group].includes(name)) return group;
    }
    return null;
}
