'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// escrowAutoRelease.js — Automated escrow lifecycle management
//
// RESPONSIBILITY
// ──────────────
// Process expired "held" escrow records (autoReleaseAt <= now) in paginated,
// memory-bounded batches. Determine per-escrow whether to release funds to the
// artisan or refund to the customer, then call the existing, audited
// releaseEscrow() / refundEscrow() functions — never duplicating their logic.
//
// DESIGN INVARIANTS
// ─────────────────
// 1. Zero custom transaction logic here — all financial atomicity lives in
//    escrow.js (releaseEscrow / refundEscrow). This module is an orchestrator.
//
// 2. Fixed timestamp cutoff: nowIso is captured once per run, before the
//    pagination loop. All pages use the same cutoff so documents that expire
//    during a long run are not processed mid-run (they wait for the next run).
//
// 3. Idempotency via status field: a processed escrow transitions from 'held'
//    to 'released' or 'refunded', dropping out of the query automatically.
//    If two concurrent runs select the same document, the second hits the
//    in-transaction re-check inside releaseEscrow/refundEscrow and receives
//    an "already processed" error — caught here, not propagated as a failure.
//
// 4. Partial-failure isolation: each escrow is processed independently via
//    Promise.allSettled. One failure never blocks others in the same batch.
//    Failures are logged to _auto_release_failures for admin review.
//
// 5. Observability: every run writes to _auto_release_runs with start/end
//    timestamps, per-outcome counts, and error details. Admins can audit all
//    runs from the Firebase console without reading Cloud Function logs.
//
// RELEASE vs REFUND ROUTING
// ─────────────────────────
//   Booking status ∈ { completed, awaiting } AND artisan assigned
//     → releaseEscrow()  — artisan receives artisanShare; platform takes commission
//
//   Any other booking state, no artisan, or booking not found
//     → refundEscrow()   — full amount returned to customer
//     Reason: if the job was truly done, the artisan had 7 days to confirm or
//     the customer had 7 days to dispute. Silence = safe default = customer refund.
//     Exception: 'completed'/'awaiting' = explicit intent to pay, treated as release.
//
// SCHEDULE: every 6 hours (exported from functions/index.js)
// TIMEOUT:  540 s  (Cloud Scheduler max for Gen 2 functions)
// MEMORY:   512 MiB
// ─────────────────────────────────────────────────────────────────────────────

const { FIRESTORE_DB_ID } = require('../config');
const { randomBytes }     = require('crypto');
const { releaseEscrow, refundEscrow } = require('./escrow');

// ── Tuning constants ──────────────────────────────────────────────────────────
// BATCH_SIZE: Firestore documents fetched per page. 100 is safe for 512 MiB RAM.
// CONCURRENT_PER_BATCH: max concurrent Firestore transactions per batch chunk.
//   10 strikes a balance between throughput and avoiding Firestore write throttling
//   when many escrows share the same artisan (transaction contention → retries).
const BATCH_SIZE          = 100;
const CONCURRENT_PER_BATCH = 10;

// ── Internal collections (Cloud Functions / Admin SDK access only) ─────────────
const COL_RUNS     = '_auto_release_runs';      // one doc per scheduler execution
const COL_FAILURES = '_auto_release_failures';  // one doc per unexpectedly-failed escrow

// ── Firestore singleton ────────────────────────────────────────────────────────

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const now   = () => new Date().toISOString();
const runId = () => `AR-${Date.now()}-${randomBytes(4).toString('hex').toUpperCase()}`;

// ── Release vs refund routing ──────────────────────────────────────────────────

/**
 * Decide whether an expired escrow should be released to the artisan or
 * refunded to the customer. This is a non-transactional read — it produces
 * a routing hint. releaseEscrow() / refundEscrow() each re-verify the escrow
 * status atomically inside their own Firestore transactions.
 *
 * @param {object} escrowData   Firestore escrow document data
 * @returns {Promise<'release'|'refund'>}
 */
async function determineOutcome(escrowData) {
    const { bookingId, artisanId: escrowArtisanId } = escrowData;

    // No booking reference — nothing to cross-check. Refund is the safe path.
    if (!bookingId) return 'refund';

    let bookingData = null;
    try {
        const snap = await db().collection('bookings').doc(bookingId).get();
        if (snap.exists) bookingData = snap.data();
    } catch (err) {
        // Transient Firestore read error — default to refund (conservative).
        console.warn(
            `[auto-release] Could not read booking ${bookingId} for escrow routing:`,
            err.message
        );
        return 'refund';
    }

    // Booking was deleted — refund the customer.
    if (!bookingData) return 'refund';

    const status    = (bookingData.status || '').toLowerCase();
    const artisanId = escrowArtisanId || bookingData.artisanId;

    // The job was marked done (completed) or is awaiting customer confirmation
    // (awaiting), AND an artisan is assigned. Release funds to the artisan.
    //
    // Note: 'awaiting' means the artisan has tapped "Mark Done" but the customer
    // hasn't confirmed yet. After 7 days, we treat this as implicit confirmation.
    if (['completed', 'awaiting'].includes(status) && artisanId) {
        return 'release';
    }

    // All other states — pending, in_progress, cancelled, unfulfilled, rejected,
    // disputed, or anything unexpected — refund the customer. The artisan had
    // 7 days to get the booking to a payable state.
    return 'refund';
}

// ── Error classification ───────────────────────────────────────────────────────

/**
 * True if the error means the escrow was already moved out of 'held' by another
 * path (manual release, manual refund, or a concurrent scheduler invocation).
 * These are expected under concurrent execution and are NOT logged as failures.
 */
function isAlreadyProcessed(err) {
    const msg = err.message || '';
    // Matches both pre-transaction check messages and in-transaction re-check messages:
    //   "Cannot release escrow with status "released"."
    //   "Cannot release escrow: status is "released" (expected "held"). ..."
    //   "Cannot refund escrow with status "refunded"."
    //   "Cannot refund escrow: status is "refunded" (expected "held" or "disputed"). ..."
    return ['"released"', '"refunded"'].some(s => msg.includes(s));
}

// ── Single-escrow processor ────────────────────────────────────────────────────

/**
 * Process one expired escrow: route to release or refund, execute, return result.
 *
 * The escrowId and escrowData are attached to any thrown error so that the
 * batch processor can log them without maintaining a parallel index array.
 *
 * @param {string} escrowId
 * @param {object} escrowData
 * @returns {Promise<EscrowResult>}
 */
async function processOneEscrow(escrowId, escrowData) {
    const { bookingId, customerId, amount } = escrowData;

    const baseResult = { escrowId, bookingId, customerId, amount };

    let routedTo;
    try {
        routedTo = await determineOutcome(escrowData);
    } catch (err) {
        // determineOutcome itself doesn't throw — but if it ever does, default to refund.
        routedTo = 'refund';
    }

    // ── Attempt 1: release to artisan ──────────────────────────────────────────
    if (routedTo === 'release') {
        try {
            await releaseEscrow(escrowId, { releasedBy: 'auto_release_scheduler' });
            return { ...baseResult, outcome: 'released' };
        } catch (err) {
            if (isAlreadyProcessed(err)) {
                return { ...baseResult, outcome: 'already_processed' };
            }
            // Artisan not yet assigned despite booking status suggesting completion.
            // This can happen when a booking is marked 'awaiting' but the dispatch
            // never assigned an artisan (emergency booking that matched manually).
            // Fall through to refund — do not re-throw.
            if (err.message?.includes('artisan is not yet assigned')) {
                routedTo = 'refund_no_artisan';
            } else {
                // Genuine unexpected error — attach context and rethrow for failure logging.
                err.escrowId   = escrowId;
                err.escrowData = escrowData;
                throw err;
            }
        }
    }

    // ── Attempt 2 (or routing decision): refund to customer ───────────────────
    const refundReason = routedTo === 'refund_no_artisan'
        ? 'Auto-release: booking expired without an artisan assignment — funds returned to customer'
        : 'Auto-release: escrow period expired after 7 days without manual release or dispute resolution';

    try {
        await refundEscrow(escrowId, {
            reason:      refundReason,
            refundedBy:  'auto_release_scheduler',
        });
        return {
            ...baseResult,
            outcome: routedTo === 'refund_no_artisan' ? 'refunded_no_artisan' : 'refunded',
        };
    } catch (err) {
        if (isAlreadyProcessed(err)) {
            return { ...baseResult, outcome: 'already_processed' };
        }
        err.escrowId   = escrowId;
        err.escrowData = escrowData;
        throw err;
    }
}

// ── Batch processor ────────────────────────────────────────────────────────────

/**
 * Process an array of escrow document snapshots with bounded concurrency.
 *
 * Iterates in chunks of CONCURRENT_PER_BATCH. Within each chunk, documents are
 * processed concurrently (Promise.allSettled). Between chunks, execution is
 * sequential, giving Firestore time to process committed transactions before the
 * next wave begins — this reduces transaction contention when multiple escrows
 * in a batch involve the same artisan's balance document.
 *
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs
 * @returns {Promise<Array<{ status: 'fulfilled'|'rejected', value?, reason? }>>}
 */
async function processBatch(docs) {
    const allResults = [];

    for (let i = 0; i < docs.length; i += CONCURRENT_PER_BATCH) {
        const chunk = docs.slice(i, i + CONCURRENT_PER_BATCH);

        const chunkResults = await Promise.allSettled(
            chunk.map(async (doc) => {
                try {
                    return await processOneEscrow(doc.id, doc.data());
                } catch (err) {
                    // Ensure escrowId is always attached to failures for the tally loop.
                    if (!err.escrowId) {
                        err.escrowId   = doc.id;
                        err.escrowData = doc.data();
                    }
                    throw err;
                }
            })
        );

        allResults.push(...chunkResults);
    }

    return allResults;
}

// ── Failure logger ─────────────────────────────────────────────────────────────

/**
 * Write a failure record to _auto_release_failures/{escrowId}.
 * Non-fatal: a failure to write the failure log must never crash the scheduler.
 */
async function logFailure(err, currentRunId) {
    const escrowId = err.escrowId || 'unknown';
    const data     = err.escrowData || {};

    try {
        await db().collection(COL_FAILURES).doc(escrowId).set({
            escrowId,
            bookingId:  data.bookingId  ?? null,
            customerId: data.customerId ?? null,
            amount:     data.amount     ?? null,
            error:      err.message,
            stack:      err.stack ? err.stack.slice(0, 500) : null,
            failedAt:   now(),
            runId:      currentRunId,
            // Overwrite any prior failure record for this escrow so admins always
            // see the most recent failure reason (not a historical one).
        });
    } catch (logErr) {
        console.error(
            `[auto-release] Could not write failure log for escrow ${escrowId}:`,
            logErr.message
        );
    }
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Run the complete escrow auto-release pass.
 *
 * Pages through all escrow documents where status == 'held' AND
 * autoReleaseAt <= nowIso, processes them in bounded batches, and writes a
 * run-log document to _auto_release_runs for each execution.
 *
 * Safe to call multiple times — idempotency is guaranteed by the escrow
 * document's status field and in-transaction re-checks inside releaseEscrow /
 * refundEscrow. Repeated executions on already-processed escrows are harmless.
 *
 * @returns {Promise<{
 *   runId: string,
 *   stats: { queried, released, refunded, refundedNoArtisan, alreadyProcessed, failed },
 *   batchesProcessed: number,
 *   durationMs: number,
 * }>}
 */
async function runAutoRelease() {
    const id       = runId();
    const startMs  = Date.now();
    const startedAt = now();

    // Capture the expiry cutoff once. All paginated queries use this fixed value
    // so documents that expire mid-run are deferred to the next execution, keeping
    // batch boundaries consistent and the run deterministic.
    const nowIso = new Date().toISOString();

    const stats = {
        queried:          0,
        released:         0,
        refunded:         0,
        refundedNoArtisan: 0,
        alreadyProcessed: 0,
        failed:           0,
    };

    const runRef = db().collection(COL_RUNS).doc(id);

    // Write the in-progress marker before the loop. If the function crashes mid-run,
    // the 'running' status marker helps admins detect a hung or crashed execution.
    await runRef.set({
        runId: id,
        startedAt,
        completedAt:      null,
        durationMs:       null,
        stats,
        batchesProcessed: 0,
        status:           'running',
        error:            null,
        cutoffTimestamp:  nowIso,
    }).catch(err => {
        // Non-fatal. A logging failure must never block financial processing.
        console.error('[auto-release] Failed to write run start log:', err.message);
    });

    let cursor         = null;
    let batchesRun     = 0;
    let topLevelError  = null;

    console.log(`[auto-release] Run ${id} started. Cutoff: ${nowIso}`);

    try {
        // ── Paginated processing loop ──────────────────────────────────────────
        // Requires composite index: escrow (status ASC, autoReleaseAt ASC).
        // See firestore.indexes.json.
        do {
            let query = db()
                .collection('escrow')
                .where('status', '==', 'held')
                .where('autoReleaseAt', '<=', nowIso)
                .orderBy('autoReleaseAt', 'asc')
                .limit(BATCH_SIZE);

            if (cursor) query = query.startAfter(cursor);

            const snap = await query.get();

            if (snap.empty) break;

            batchesRun++;
            stats.queried += snap.docs.length;

            console.log(
                `[auto-release] Run ${id} — batch ${batchesRun}: ` +
                `processing ${snap.docs.length} expired escrow(s).`
            );

            // ── Process this batch with bounded concurrency ────────────────────
            const results = await processBatch(snap.docs);

            // ── Tally results and log individual failures ──────────────────────
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    const { outcome, escrowId, bookingId } = result.value;

                    switch (outcome) {
                        case 'released':
                            stats.released++;
                            console.log(
                                `[auto-release] ✓ Released   escrow ${escrowId}` +
                                (bookingId ? ` (booking ${bookingId})` : '')
                            );
                            break;
                        case 'refunded':
                            stats.refunded++;
                            console.log(
                                `[auto-release] ✓ Refunded   escrow ${escrowId}` +
                                (bookingId ? ` (booking ${bookingId})` : '')
                            );
                            break;
                        case 'refunded_no_artisan':
                            stats.refunded++;
                            stats.refundedNoArtisan++;
                            console.log(
                                `[auto-release] ✓ Refunded   escrow ${escrowId}` +
                                ` (no artisan assigned)` +
                                (bookingId ? ` (booking ${bookingId})` : '')
                            );
                            break;
                        case 'already_processed':
                            stats.alreadyProcessed++;
                            console.log(
                                `[auto-release] ↩ Already    processed escrow ${escrowId} — skipped.`
                            );
                            break;
                        default:
                            console.warn(
                                `[auto-release] Unknown outcome "${outcome}" for escrow ${escrowId}`
                            );
                    }
                } else {
                    // Unexpected error — count it and write a failure record.
                    stats.failed++;
                    const err = result.reason;
                    console.error(
                        `[auto-release] ✗ FAILED     escrow ${err.escrowId || 'unknown'}:`,
                        err.message
                    );
                    await logFailure(err, id);
                }
            }

            // Advance cursor to the last document of this page.
            cursor = snap.docs[snap.docs.length - 1];

            // Stop if we got fewer docs than the page size — last page reached.
            if (snap.docs.length < BATCH_SIZE) break;

        } while (true);

    } catch (err) {
        // A top-level error (e.g. Firestore query failure) aborts the current run
        // but does not corrupt any financial data — no escrow was modified outside
        // of a successful releaseEscrow / refundEscrow transaction.
        topLevelError = err.message;
        console.error('[auto-release] Run aborted by top-level error:', err.message);
    }

    // ── Write final run log ────────────────────────────────────────────────────
    const durationMs  = Date.now() - startMs;
    const finalStatus = topLevelError
        ? 'aborted'
        : stats.failed > 0 ? 'partial_failure' : 'completed';

    await runRef.update({
        completedAt:      now(),
        durationMs,
        stats: {
            queried:           stats.queried,
            released:          stats.released,
            refunded:          stats.refunded,
            refundedNoArtisan: stats.refundedNoArtisan,
            alreadyProcessed:  stats.alreadyProcessed,
            failed:            stats.failed,
        },
        batchesProcessed: batchesRun,
        status:           finalStatus,
        error:            topLevelError || null,
    }).catch(logErr => {
        console.error('[auto-release] Failed to update run completion log:', logErr.message);
    });

    const summary =
        `Released: ${stats.released}, ` +
        `Refunded: ${stats.refunded} (${stats.refundedNoArtisan} no-artisan), ` +
        `Already done: ${stats.alreadyProcessed}, ` +
        `Failed: ${stats.failed}`;

    console.log(
        `[auto-release] Run ${id} ${finalStatus.toUpperCase()} ` +
        `in ${durationMs}ms. ${summary}`
    );

    // Re-throw top-level errors so Cloud Scheduler marks the run as failed,
    // triggering its configured alerting / retry policy.
    if (topLevelError) {
        throw new Error(`[auto-release] Run ${id} aborted: ${topLevelError}`);
    }

    return {
        runId:            id,
        stats,
        batchesProcessed: batchesRun,
        durationMs,
    };
}

module.exports = { runAutoRelease };
