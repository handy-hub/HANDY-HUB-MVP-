// ─────────────────────────────────────────────────────────────────────────────
// callable — the one way the apps call a Cloud Function by name.
//
//   import { callable } from '../../shared/js/services/callable.js';
//   const { data } = await callable('verifyTopupNow')({ reference });
//
// A drop-in for httpsCallable(firebaseFunctions, name): same call, same
// { data } result, same errors. The difference is that an action belonging to
// a group (shared/js/domain/callableGroups.js) is sent to its group router as
// { action, payload } — one server function serving many people at once,
// instead of one small function per action (CLAUDE.md §4, CPU quota).
//
// FALLBACK — only when the router never ran
// ─────────────────────────────────────────
// If the router is not deployed (404), not yet open to callers (403 from the
// platform, the invoker-IAM failure CLAUDE.md §4 warns about), or does not know
// the action yet, the call goes to the action's own function instead. Those
// three cases are recognisable because the request never reached any handler:
// the platform answers with an HTML page, which the SDK reports as a bare code
// with no message and no details, and the router's own refusal carries
// reason 'unknown_action'. Anything else — including a handler's own
// 'not-found' or 'permission-denied', which always carries a message — is the
// answer, and is never retried: retrying could run a payment twice.
// ─────────────────────────────────────────────────────────────────────────────

import { httpsCallable }
    from '../../vendor/firebase/firebase-functions.js';
import { firebaseFunctions }
    from '../backend/providers/firebase/firebaseConfig.js';
import { groupOf, ROUTER_ONLY }
    from '../domain/callableGroups.js';

// Routers found missing on this page load: later calls skip straight to the
// action's own function instead of paying a failed round trip each time.
const _missingRouters = new Set();

/** True when the router itself was never reached — safe to call the action directly. */
export function routerNeverRan(err) {
    if (!err || typeof err.code !== 'string') return false;
    const code = err.code.replace(/^functions\//, '');
    if (code === 'unimplemented' && err.details && err.details.reason === 'unknown_action') return true;
    const bare = err.message === code && err.details === undefined;
    return bare && (code === 'not-found' || code === 'permission-denied');
}

/**
 * @param {string} name       the action, e.g. 'verifyTopupNow'
 * @param {object} [functions] a Functions instance (defaults to the app's)
 * @returns {(data?: any) => Promise<{ data: any }>}
 */
export function callable(name, functions = firebaseFunctions) {
    const direct = httpsCallable(functions, name);
    const group  = groupOf(name);
    if (!group) return direct;

    const routed = httpsCallable(functions, group);
    // A router-only action has no function of its own to fall back to.
    if (ROUTER_ONLY.includes(name)) {
        return (data) => routed({ action: name, payload: data === undefined ? null : data });
    }
    return async (data) => {
        if (!_missingRouters.has(group)) {
            try {
                return await routed({ action: name, payload: data === undefined ? null : data });
            } catch (err) {
                if (!routerNeverRan(err)) throw err;
                const code = String(err.code).replace(/^functions\//, '');
                if (code !== 'unimplemented') _missingRouters.add(group);
                console.warn(`[callable] ${group} unavailable for ${name} (${code}) — calling ${name} directly.`);
            }
        }
        return direct(data);
    };
}
