'use strict';

/**
 * quotes.js — Job quote lifecycle
 *
 * Flow:
 *   1. Artisan submits quote (labour + optional materials list)
 *      → booking gains jobQuote, materials fields
 *      → status: accepted → quoted            (legacy track)
 *                inspection_done → quoted     (inspection track)
 *      → customer notified
 *
 *   2. Customer approves quote
 *      → inspection track: callout fee CREDITED toward the job —
 *        escrow holds (jobQuote − calloutFee), callout escrow released to artisan
 *      → legacy track: escrow holds full jobQuote
 *      → status: quoted → accepted  (artisan can now go en_route)
 *      → artisan notified
 *
 *   3. Customer rejects quote — SINGLE REVISION RULE (no bargaining loops):
 *      → 1st rejection: status reverts (inspection_done / accepted),
 *        quoteRevisionCount → 1, artisan may submit ONE revised quote
 *      → 2nd rejection: FINAL — booking cancelled; on the inspection track the
 *        callout escrow is released to the artisan (inspection was delivered)
 */

const { FieldValue } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID, COMMISSION_RATE, MAX_QUOTE_GHS } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const escrow = require('./financial/escrow');
// Generated mirror of shared/js/domain/quoteMoney.js — the one definition of a
// valid quote amount, shared with the artisan's quote composer (AR-08).
const quoteMoney = require('./shared/quoteMoney');
// claimBookingTransition is the shared atomic compare-and-set primitive (F4).
// Lazy-required inside handlers to avoid a require cycle (pricing.js requires
// this module's sibling escrow, and requires quotes indirectly via index).
function claimBookingTransition(...args) {
    return require('./pricing').claimBookingTransition(...args);
}

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const fmt = (n) => parseFloat(Number(n).toFixed(2));

// ─────────────────────────────────────────────────────────────────────────────
// computeQuoteSettlement — THE settlement formula. One definition, two callers.
//
// submitJobQuote writes the result as a PREVIEW so the customer's approval
// screen can state the real additional amount due without doing arithmetic of
// its own; approveJobQuote recomputes it at the moment money actually moves and
// writes the settled values. Both go through here, so the number the customer
// approves is the number that is charged — previously the client rendered the
// gross quote as the amount payable while the ledger correctly charged the
// difference, and the two disagreed by the whole value of the callout credit.
//
// Pure and side-effect free so the same function can be unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────
function computeQuoteSettlement(booking, jobQuoteOverride) {
    const jobQuote = fmt(Number(
        jobQuoteOverride !== undefined ? jobQuoteOverride : (booking.jobQuote || 0),
    ));

    const isInspection = booking.track === 'inspection';

    // The callout fee is only a credit once it has actually been paid. An
    // unpaid callout must never reduce what the customer owes.
    const calloutCredit = (isInspection && booking.calloutPaid)
        ? fmt(Number(booking.calloutFee || 0))
        : 0;

    // The credit can cover the quote entirely, but never produces a negative
    // charge — surplus credit is not refunded here, it is simply not re-charged.
    const amountDue = fmt(Math.max(jobQuote - calloutCredit, 0));

    return { jobQuote, calloutCredit, amountDue };
}

// ─────────────────────────────────────────────────────────────────────────────
// submitJobQuote
//
// Called by: artisan app
// Payload:
//   bookingId   string
//   labourCost  number           artisan's labour charge
//   materials   array (optional) [{ name, qty, unitPrice }]
//   note        string (optional)
// ─────────────────────────────────────────────────────────────────────────────
async function submitJobQuote(auth, { bookingId, labourCost, materials = [], note = '' } = {}) {
    if (!bookingId || typeof bookingId !== 'string') throw new Error('bookingId is required.');

    // ── Validate every amount BEFORE anything is read or written (AR-08) ────
    // A malformed or out-of-policy value is refused here and never reaches the
    // booking, so it can never become a quote that cannot be approved.
    const checked = quoteMoney.validateQuoteInput({ labourCost, materials, note }, { maxQuoteGHS: MAX_QUOTE_GHS });
    if (!checked.ok) {
        const err = new Error(checked.message);
        err.reason = 'invalid_quote';
        err.fields = checked.errors.map((e) => e.field);
        throw err;
    }
    const q = checked.quote;

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');

    const preBooking = bookingSnap.data();

    // Only the assigned artisan may submit a quote
    if (preBooking.artisanId !== auth.uid) throw new Error('Not authorised for this booking.');

    // Legacy track quotes from 'accepted'; inspection track only after the
    // inspection is actually done.
    const quotableFrom = preBooking.track === 'inspection' ? ['inspection_done'] : ['accepted'];
    if (!quotableFrom.includes(preBooking.status)) {
        throw new Error(`Cannot submit quote — booking is ${preBooking.status}.`);
    }

    // Single-revision rule: initial quote + at most one revision.
    if (Number(preBooking.quoteRevisionCount || 0) >= 2) {
        throw new Error('Quote revision limit reached for this booking.');
    }

    // Totals come from the validator, computed in whole pesewas.
    const cleanMaterials = q.materials;
    const materialsCost  = q.materialsCost;
    const labourCostFmt  = q.labourCost;
    const jobQuote       = q.jobQuote;
    const artisanEarns   = fmt(jobQuote * (1 - COMMISSION_RATE));
    const platformFee    = fmt(jobQuote * COMMISSION_RATE);

    // Settlement preview, computed server-side from the SAME formula approval
    // will use. The customer's approval screen renders these verbatim; it must
    // never derive "amount due" from calloutFee/calloutPaid itself, or a second
    // source of truth is born.
    const preview = computeQuoteSettlement(preBooking, jobQuote);

    // ── Claim <quotableFrom> → quoted atomically with the quote payload (F4) ──
    // Serializes a double-submit and a submit racing a customer cancel: whoever
    // claims first moves the booking to 'quoted'; the loser aborts.
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'artisan',
        fromStatuses: quotableFrom,
        guard: (b) => Number(b.quoteRevisionCount || 0) < 2,
        guardMessage: 'Quote revision limit reached for this booking.',
        patch: {
            status:              'quoted',
            jobQuote,
            labourCost:          labourCostFmt,
            materials:           cleanMaterials,
            materialsCost,
            hasMaterials:        cleanMaterials.length > 0,
            quoteNote:           q.note,
            commissionRate:      COMMISSION_RATE,   // locked at quote time
            artisanEarns,
            platformFee,
            // Authoritative preview of what approval will actually charge.
            calloutCreditPreview: preview.calloutCredit,
            amountDuePreview:     preview.amountDue,
            quoteSubmittedAt:    new Date().toISOString(),
        },
    });

    // ── Notify customer ──────────────────────────────────────────────────────
    const artisanName = booking.artisanName || 'Your artisan';
    const serviceType = booking.serviceType || 'service';

    await sendNotification(booking.customerId, {
        type:      'Bookings',
        title:     'Quote Ready for Approval',
        message:   `${artisanName} has sent a quote of GHS ${jobQuote.toFixed(2)} for your ${serviceType} job. Tap to review and approve.`,
        actionUrl: `dashboard.html?openQuote=${bookingId}`,
        bookingId,
    }).catch(() => {});

    console.log(`[quotes] Quote submitted: booking=${bookingId} total=GHS${jobQuote} labour=GHS${labourCostFmt} materials=GHS${materialsCost}`);
    return { success: true, jobQuote, labourCost: labourCostFmt, materialsCost, artisanEarns };
}

// ─────────────────────────────────────────────────────────────────────────────
// approveJobQuote
//
// Called by: customer app
// Payload: { bookingId }
//
// THE FUNDING RULE. A booking becomes approved (status 'accepted',
// quoteApproved: true — the state that tells the artisan to set out) in the
// SAME Firestore transaction that moves the money into escrow. Neither can
// exist without the other:
//   • short wallet, conflicting lock, artisan no longer available, quote
//     changed → the transaction throws and NOTHING commits: the booking is still
//     'quoted', no money moved, and the customer can top up and approve again;
//   • success → booking approved, booking.escrowId set, wallet debited, escrow
//     and lock written — one commit.
// The hold is wallet → escrow, entirely inside Firestore; no payment provider
// is involved, so one transaction is a real atomic boundary.
//
// Retries and concurrent approvals (double tap, two tabs, a response lost on a
// bad network): Firestore serialises the transactions, so whichever commits
// second re-reads an approved booking and gets the same answer back
// (idempotent: true) without touching the money — provided the hold that
// approval needs is really there.
//
// After the commit, outside the transaction and recoverable: the callout credit
// is released to the artisan (settleCallout flags failures for the hourly
// retry), and both parties are notified.
// ─────────────────────────────────────────────────────────────────────────────
const POST_APPROVAL_STATUSES = ['accepted', 'en_route', 'in_progress', 'awaiting', 'completed'];

/** An error the callable can hand to the client with a machine-readable reason. */
function approvalError(reason, message, extra = {}) {
    const err = new Error(message);
    err.reason = reason;
    Object.assign(err, extra);
    return err;
}

// ── A stored quote that cannot be priced (AR-08) ─────────────────────────────
// New quotes are validated on submit, but a booking written before that may
// hold a NaN or out-of-policy quote. Such a quote can never be approved, and
// before this the customer's only ways out — rejecting it or letting it expire
// — cancelled the job and, on the inspection track, paid the callout fee to the
// artisan for a quote the customer was never able to accept.
//
// So an invalid stored quote is VOIDED instead: the booking returns to the
// state the artisan quotes from, the quote fields are cleared, and — because
// the fault is in the quote, not in the customer's decision — no revision is
// used up and no money moves. The artisan is asked for a corrected quote.
// Every caller claims the transition atomically (its own transaction or
// claimBookingTransition), so a void can never race an approval.
function voidQuotePatch(booking, problems) {
    return {
        status:               booking.track === 'inspection' ? 'inspection_done' : 'accepted',
        quoteApproved:        false,
        quoteVoidedAt:        new Date().toISOString(),
        quoteVoidReason:      'invalid_amounts',
        quoteVoidProblems:    (problems || []).slice(0, 10),
        jobQuote:             FieldValue.delete(),
        labourCost:           FieldValue.delete(),
        materials:            FieldValue.delete(),
        materialsCost:        FieldValue.delete(),
        hasMaterials:         FieldValue.delete(),
        quoteNote:            FieldValue.delete(),
        quoteSubmittedAt:     FieldValue.delete(),
        artisanEarns:         FieldValue.delete(),
        platformFee:          FieldValue.delete(),
        calloutCreditPreview: FieldValue.delete(),
        amountDuePreview:     FieldValue.delete(),
        updatedAt:            new Date().toISOString(),
    };
}

async function notifyQuoteVoided(booking, bookingId) {
    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     'Please send your quote again',
        message:   'Your quote could not be approved because its amounts were invalid. ' +
                   'Send a corrected quote — this does not count as a revision.',
        actionUrl: 'jobs.html',
        bookingId,
    }).catch(() => {});
    await sendNotification(booking.customerId, {
        type:      'Bookings',
        title:     'Quote withdrawn for correction',
        message:   'The quote for this job had invalid amounts, so it was withdrawn. No money was taken, ' +
                   'and the artisan has been asked to send a corrected quote.',
        actionUrl: 'booking.html',
        bookingId,
    }).catch(() => {});
}

const storedQuoteCheck = (b) => quoteMoney.checkStoredQuote(b, { maxQuoteGHS: MAX_QUOTE_GHS });

async function approveJobQuote(auth, { bookingId } = {}) {
    if (!bookingId) throw new Error('bookingId is required.');

    const firestore  = db();
    const bookingRef = firestore.collection('bookings').doc(bookingId);
    const lockRef    = firestore.collection('_escrow_locks').doc(bookingId);   // the job hold's mutex

    // ── Plan from a first read; decide again inside the transaction ──────────
    // The hold's document references are allocated up front so they are stable
    // across transaction retries. Nothing here is trusted for a decision: the
    // transaction re-reads the booking and re-derives every figure.
    const preSnap = await bookingRef.get();
    if (!preSnap.exists) throw new Error('Booking not found.');
    const pre = preSnap.data();
    if (pre.customerId !== auth.uid) throw new Error('Not authorised for this booking.');

    let hold = null;
    if (pre.status === 'quoted' && storedQuoteCheck(pre).ok) {
        const preQuote = Number(pre.jobQuote);
        const preDue = computeQuoteSettlement(pre, preQuote).amountDue;
        if (preDue > 0) {
            hold = escrow.planHold({
                bookingId,
                customerId: pre.customerId,
                artisanId:  pre.artisanId || null,
                amount:     preDue,
                kind:       'job',
            });
        }
    }
    const artisanRef = pre.artisanId ? firestore.collection('artisans').doc(pre.artisanId) : null;

    const outcome = await firestore.runTransaction(async (txn) => {
        // ── READS (all of them, before any write) ─────────────────────────────
        const snap        = await txn.get(bookingRef);
        const holdReads   = hold ? await escrow.readHold(txn, hold) : null;
        const lockSnap    = holdReads ? holdReads.lockSnap : await txn.get(lockRef);
        const artisanSnap = artisanRef ? await txn.get(artisanRef) : null;

        if (!snap.exists) throw new Error('Booking not found.');
        const b = snap.data();
        if (b.customerId !== auth.uid) throw new Error('Not authorised for this booking.');

        // ── Already approved: answer the replay truthfully ────────────────────
        if (b.status !== 'quoted') {
            if (b.quoteApproved === true && POST_APPROVAL_STATUSES.includes(b.status)) {
                const due  = fmt(Number(b.escrowHeldAmount || 0));
                const lock = lockSnap.exists ? lockSnap.data() : null;
                const funded = due === 0 ||
                    (!!lock && lock.customerId === b.customerId && fmt(lock.amount) === due);
                if (!funded) {
                    // Only a booking approved before this rule existed can be here.
                    throw approvalError('funding_missing',
                        'This quote was approved but no payment is secured for it. ' +
                        'Contact support before the work goes ahead — no money has been taken.');
                }
                return { replay: true, booking: b, escrowId: lock ? lock.escrowId : (b.escrowId || null) };
            }
            throw new Error(`Quote cannot be approved — booking is ${b.status}.`);
        }

        // ── An unpriceable quote is voided, never charged (AR-08) ─────────────
        const stored = storedQuoteCheck(b);
        if (!stored.ok) {
            txn.update(bookingRef, voidQuotePatch(b, stored.problems));
            return { voided: true, booking: b, problems: stored.problems };
        }

        // ── Fresh approval ────────────────────────────────────────────────────
        const jobQuote = Number(b.jobQuote);

        // Re-verify the artisan is still active before locking funds.
        if (artisanRef) {
            const a = artisanSnap && artisanSnap.exists ? artisanSnap.data() : null;
            if (b.artisanId !== pre.artisanId || !a || a.status !== 'active' || a.verificationStatus !== 'approved') {
                throw approvalError('artisan_unavailable',
                    'The artisan is no longer available. Please contact support.');
            }
        }

        // Same formula the quote-submit preview used, so what the customer
        // approved on screen is exactly what moves here.
        const settlement    = computeQuoteSettlement(b, jobQuote);
        const calloutCredit = settlement.calloutCredit;
        const escrowAmount  = settlement.amountDue;

        let held = null;
        if (escrowAmount > 0 || hold) {
            if (!hold || hold.amountNum !== fmt(escrowAmount)) {
                throw approvalError('quote_changed',
                    'The quote changed while you were approving it. Review the new amount and approve again.');
            }
            // Throws (insufficient_balance / escrow_conflict / customer_missing)
            // → the whole transaction, booking update included, commits nothing.
            held = escrow.applyHold(txn, hold, holdReads);
        }

        txn.update(bookingRef, {
            status:           'accepted',   // the artisan may now set out
            quoteApproved:    true,
            quoteApprovedAt:  new Date().toISOString(),
            calloutCredit,
            escrowHeldAmount: escrowAmount,
            // The hold this approval rests on. Receipts and completion read it.
            ...(held ? { escrowId: held.escrowId } : {}),
            updatedAt:        new Date().toISOString(),
        });

        return { replay: false, booking: b, held, jobQuote, calloutCredit, escrowAmount };
    });

    if (outcome.voided) {
        await notifyQuoteVoided(outcome.booking, bookingId);
        console.warn(`[quotes] Invalid stored quote voided on approval: booking=${bookingId} problems=${outcome.problems.join(',')}`);
        throw approvalError('quote_invalid',
            'This quote had invalid amounts and has been withdrawn. No money was taken, ' +
            'and the artisan has been asked to send a corrected quote.');
    }

    if (outcome.replay) {
        const b = outcome.booking;
        console.log(`[quotes] Approval replay: booking=${bookingId} status=${b.status} — no money moved.`);
        return {
            success:       true,
            idempotent:    true,
            jobQuote:      Number(b.jobQuote || 0),
            calloutCredit: Number(b.calloutCredit || 0),
            escrowAmount:  Number(b.escrowHeldAmount || 0),
            escrowId:      outcome.escrowId,
        };
    }

    const { booking, held, jobQuote, calloutCredit, escrowAmount } = outcome;
    if (held && !held.idempotent) escrow.notifyHoldSecured(hold);

    // ── Release the callout escrow to the artisan (credited into the job) ────
    // Failure is non-fatal: settleCallout flags the booking and the hourly
    // sweeper retries.
    if (calloutCredit > 0) {
        const pricing = require('./pricing');
        await pricing.settleCallout(booking, bookingId, 'artisan', 'quote_approved_credit');
    }

    // ── Notify artisan — true by construction: the commit above holds the money ─
    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     'Quote Approved!',
        message:   escrowAmount > 0
            ? `Your quote of GHS ${jobQuote.toFixed(2)} was approved. Payment is secured in escrow. You can now head to the job.`
            : `Your quote of GHS ${jobQuote.toFixed(2)} was approved and is covered by the visit fee already paid. You can now head to the job.`,
        actionUrl: `jobs.html`,
        bookingId,
    }).catch(() => {});

    console.log(`[quotes] Quote approved: booking=${bookingId} quote=GHS${jobQuote} credit=GHS${calloutCredit} escrowed=GHS${escrowAmount}`);
    return {
        success: true,
        idempotent: false,
        jobQuote, calloutCredit, escrowAmount,
        escrowId: held ? held.escrowId : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectJobQuote
//
// Called by: customer app
// Payload: { bookingId, reason? }
// SINGLE REVISION RULE:
//   1st rejection → artisan may submit exactly ONE revised quote
//   2nd rejection → FINAL: booking cancelled. Inspection track: callout escrow
//                   released to the artisan (the inspection was delivered).
// ─────────────────────────────────────────────────────────────────────────────
async function rejectJobQuote(auth, { bookingId, reason = '' }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');

    const preBooking = bookingSnap.data();

    if (preBooking.customerId !== auth.uid) throw new Error('Not authorised for this booking.');
    if (preBooking.status !== 'quoted')     throw new Error(`Cannot reject — booking is ${preBooking.status}.`);

    const prevQuote  = preBooking.jobQuote;
    const rejections = Number(preBooking.quoteRevisionCount || 0);
    const cleanReason = (typeof reason === 'string' ? reason : '').trim().slice(0, 300);

    // ── An unpriceable quote is voided: no revision used, no money moved ────
    // Rejecting it must not use up the artisan's one revision, and a second
    // rejection must not close the job and pay the callout fee for a quote the
    // customer could never have approved (AR-08).
    const stored = storedQuoteCheck(preBooking);
    if (!stored.ok) {
        const booking = await claimBookingTransition(bookingRef, {
            authUid: auth.uid,
            party:   'customer',
            fromStatuses: ['quoted'],
            patch: voidQuotePatch(preBooking, stored.problems),
        });
        await notifyQuoteVoided(booking, bookingId);
        console.warn(`[quotes] Invalid stored quote voided on rejection: booking=${bookingId} problems=${stored.problems.join(',')}`);
        return { success: true, final: false, voided: true };
    }

    // ── 2nd rejection — FINAL. No bargaining loops. ──────────────────────────
    if (rejections >= 1) {
        // Claim quoted → cancelled atomically BEFORE settling the callout (F4),
        // so a concurrent approve cannot also fire. settleCallout is idempotent.
        const booking = await claimBookingTransition(bookingRef, {
            authUid: auth.uid,
            party:   'customer',
            fromStatuses: ['quoted'],
            patch: {
                status:               'cancelled',
                quoteApproved:        false,
                quoteRejectedAt:      new Date().toISOString(),
                quoteRejectionReason: cleanReason,
                cancellationReason:   'quote_rejected_final',
                cancelledBy:          'customer',
                cancelledAt:          new Date().toISOString(),
                // The artisan is notified below; the status trigger tells only
                // the customer (ART-NOTIF-003).
                cancelNotified:       ['artisan'],
            },
        });

        if (booking.track === 'inspection' && booking.calloutPaid) {
            const pricing = require('./pricing');
            await pricing.settleCallout(booking, bookingId, 'artisan', 'quote_rejected_final');
        }

        await sendArtisanNotification(booking.artisanId, {
            type:      'Bookings',
            title:     'Quote Declined — Booking Closed',
            message:   `The customer declined your revised quote of GHS ${prevQuote}. The booking is closed${booking.calloutPaid ? ' and the callout fee has been released to you' : ''}.`,
            actionUrl: 'jobs.html',
            bookingId,
        }).catch(() => {});

        console.log(`[quotes] Quote FINAL-rejected: booking=${bookingId} prevQuote=GHS${prevQuote}`);
        return { success: true, final: true };
    }

    // ── 1st rejection — revert so artisan can submit ONE revision ────────────
    // Claim quoted → revertTo atomically (F4): no money moves on a first
    // rejection, but this still prevents a concurrent approve from firing.
    const revertTo = preBooking.track === 'inspection' ? 'inspection_done' : 'accepted';
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'customer',
        fromStatuses: ['quoted'],
        patch: {
            status:             revertTo,
            quoteApproved:      false,
            quoteRevisionCount: rejections + 1,
            quoteRejectedAt:    new Date().toISOString(),
            quoteRejectionReason: cleanReason,
            // Clear the old quote so artisan starts fresh
            jobQuote:         FieldValue.delete(),
            labourCost:       FieldValue.delete(),
            materials:        FieldValue.delete(),
            materialsCost:    FieldValue.delete(),
            hasMaterials:     FieldValue.delete(),
            quoteNote:        FieldValue.delete(),
            quoteSubmittedAt: FieldValue.delete(),
            artisanEarns:     FieldValue.delete(),
            platformFee:      FieldValue.delete(),
        },
    });

    // ── Notify artisan ───────────────────────────────────────────────────────
    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     'Quote Rejected — One Revision Left',
        message:   reason
            ? `Customer rejected your GHS ${prevQuote} quote: "${cleanReason}". You may submit ONE revised quote.`
            : `Customer rejected your GHS ${prevQuote} quote. You may submit ONE revised quote.`,
        actionUrl: 'jobs.html',
        bookingId,
    }).catch(() => {});

    console.log(`[quotes] Quote rejected (revision 1 allowed): booking=${bookingId} prevQuote=GHS${prevQuote}`);
    return { success: true, final: false };
}

// computeQuoteSettlement is exported for the regression suite: the settlement
// formula is the one piece of arithmetic the customer's approval screen and the
// ledger must agree on, so it is tested directly rather than only through a
// deployed callable.
module.exports = {
    submitJobQuote, approveJobQuote, rejectJobQuote, computeQuoteSettlement,
    voidQuotePatch, notifyQuoteVoided, storedQuoteCheck,
};
