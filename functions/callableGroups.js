'use strict';

/**
 * functions/callableGroups.js — one deployed function serving a group of
 * callable actions.
 *
 * WHY
 * ───
 * The region's CPU quota (20 vCPU of running instances, CLAUDE.md §4) is spent
 * by one small function per action, each serving ONE request at a time. A group
 * router is one function with a full vCPU that serves many requests at once, so
 * the same quota carries far more simultaneous users.
 *
 * WHAT IT DOES — AND DOES NOT
 * ───────────────────────────
 * It looks up `action` and runs that action's EXISTING handler, the very
 * function its own export runs (`.run`), with `payload` as the request data and
 * the caller's auth unchanged. Every check stays where it was: auth, the rate
 * limit, input validation, the error codes. The router adds no business logic
 * and, for the wallet, no money path — a top-up still credits only through
 * settleTopupByReference.
 *
 *   client → walletActions({ action: 'verifyTopupNow', payload: { reference } })
 *          ≡ verifyTopupNow({ reference })
 *
 * An unknown action is 'unimplemented', which is the client's signal to call
 * the action by its own name instead (shared/js/services/callable.js), so a
 * client newer than the deployed router still works.
 */

const { HttpsError } = require('firebase-functions/v2/https');
const { CALLABLE_GROUPS } = require('./shared/callableGroups');

/**
 * @param {string} group      a key of CALLABLE_GROUPS
 * @param {object} callables  the exports holding each action's own callable
 * @returns {(request) => Promise<any>} the onCall handler for the router
 */
function createGroupRouter(group, callables) {
    const actions = CALLABLE_GROUPS[group];
    if (!actions) throw new Error(`Unknown callable group: ${group}`);

    // Resolved at load time, so a missing or misnamed action fails the deploy's
    // discovery step loudly instead of failing a customer later.
    const handlers = new Map();
    for (const name of actions) {
        const fn = callables[name];
        const run = fn && typeof fn.run === 'function' ? fn.run
                  : typeof fn === 'function' ? fn
                  : null;
        if (!run) throw new Error(`${group}: "${name}" is not an exported callable`);
        handlers.set(name, run);
    }

    return async function groupRouter(request) {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.');

        const { action, payload } = request.data || {};
        const run = typeof action === 'string' ? handlers.get(action) : undefined;
        if (!run) {
            throw new HttpsError('unimplemented', `Unknown ${group} action.`, { reason: 'unknown_action' });
        }
        return run({ ...request, data: payload === undefined ? null : payload });
    };
}

module.exports = { createGroupRouter, CALLABLE_GROUPS };
