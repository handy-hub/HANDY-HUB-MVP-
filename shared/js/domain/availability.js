/**
 * availability.js — whether an artisan is taking jobs, and who may change it.
 *
 * TWO DIFFERENT THINGS, TWO FIELDS
 * ────────────────────────────────
 *   isAvailable  the artisan's own CHOICE ("Go Online" / "Go Offline"). Dispatch
 *                reads it from artisan_index (functions/dispatch.js), approval and
 *                suspension reset it server-side (functions/artisanVerification.js).
 *   isOnline     mirrors that choice for customer-facing badges and the dispatch
 *                ranking's "online" points (performanceMetrics.js).
 *
 * Neither may be written by page lifecycle. This is a multi-page app: every tap
 * on a link unloads the page, and the presence service used to write
 * isAvailable:false on pagehide, on a hidden tab and on a network blip, then
 * isAvailable:true when the dashboard loaded again. So an artisan checking their
 * wallet dropped out of dispatch, and one who had chosen "Go Offline" was put
 * back online by the next dashboard visit (audit FLOW-001/002, 28 Oct 2026).
 * Presence (heartbeat, GPS) now only refreshes timestamps and location; the
 * choice changes through requestAvailability alone.
 *
 * Pure module: no imports, no DOM, no Firestore. presenceService.js wires it to
 * the repository and the GPS; tests/artisan-availability.test.cjs drives it.
 */

/** Profile fields only an explicit availability change may write. */
export const AVAILABILITY_FIELDS = Object.freeze(['isAvailable', 'isOnline']);

/**
 * Why this artisan may not go online right now, or null when they may.
 * Mirrors the eligibility dispatch applies (status 'active', verificationStatus
 * 'approved') so the artisan hears the reason instead of silently receiving
 * nothing. Going OFFLINE is never blocked.
 *
 * @param {object|null} artisan  artisans/{uid} data
 * @returns {null | { reason: string, message: string }}
 */
export function availabilityBlocker(artisan) {
    if (!artisan || typeof artisan !== 'object') {
        return { reason: 'unknown', message: 'Your profile has not loaded yet. Check your connection and try again.' };
    }
    const status = String(artisan.status || '').toLowerCase();
    if (status === 'suspended' || status === 'banned' || status === 'closed') {
        return { reason: 'suspended', message: 'Your account is not active, so you cannot go online. Contact support.' };
    }
    const kyc = String(artisan.verificationStatus || '').toLowerCase();
    if (kyc === 'pending_review' || kyc === 'submitted') {
        return { reason: 'under_review', message: 'Your verification is under review. You can go online once it is approved.' };
    }
    if (kyc !== 'approved') {
        return { reason: 'unverified', message: 'Complete your verification to go online and receive jobs.' };
    }
    if (status && status !== 'active') {
        return { reason: 'inactive', message: 'Your account is not active yet, so you cannot go online.' };
    }
    return null;
}

/** The artisan's stored choice, as a strict boolean. A missing field is "not available". */
export function storedAvailability(artisan) {
    return !!(artisan && artisan.isAvailable === true);
}

/**
 * Serialises explicit availability changes so the LAST tap wins.
 *
 * Going online needs a GPS fix first, which can take seconds; a "Go Offline"
 * tapped meanwhile must not be overtaken by the earlier "Go Online" finishing
 * late. Requests therefore run one at a time, in the order made, and a request
 * that has been superseded before it writes is dropped instead of written.
 *
 * @param {{ write: (available: boolean, coords: object|null) => Promise<any>,
 *           acquirePosition: () => Promise<object> }} deps
 *        write: persists the choice (isAvailable and isOnline together)
 *        acquirePosition: resolves a GPS fix; rejects with a user-facing message
 */
export function createAvailabilityQueue({ write, acquirePosition }) {
    if (typeof write !== 'function') throw new TypeError('write is required');
    let seq     = 0;
    let pending = 0;
    let chain   = Promise.resolve();

    function request(available) {
        const mine = ++seq;
        const want = !!available;
        const run = async () => {
            if (mine !== seq) return { ok: false, superseded: true, available: want };
            let coords = null;
            if (want && typeof acquirePosition === 'function') {
                coords = await acquirePosition();
                if (mine !== seq) return { ok: false, superseded: true, available: want };
            }
            const w = await write(want, coords);
            // queued: saved on this device, not yet confirmed by the server
            // (offline or reconnecting). Firestore sends it when it can.
            return { ok: true, superseded: false, available: want, coords, queued: !!(w && w.queued) };
        };
        pending++;
        const result = chain.then(run, run);
        const settle = () => { pending--; };
        result.then(settle, settle);
        chain = result.catch(() => {});
        return result;
    }

    return {
        request,
        /** true while any request made through this queue has not settled. */
        get busy() { return pending > 0; },
    };
}
