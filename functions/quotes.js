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
// submitJobQuote
//
// Called by: artisan app
// Payload:
//   bookingId   string
//   labourCost  number           artisan's labour charge
//   materials   array (optional) [{ name, qty, unitPrice }]
//   note        string (optional)
// ─────────────────────────────────────────────────────────────────────────────
async function submitJobQuote(auth, { bookingId, labourCost, materials = [], note = '' }) {
    if (!bookingId)            throw new Error('bookingId is required.');
    if (!labourCost || Number(labourCost) <= 0) throw new Error('Labour cost must be greater than 0.');
    if (Number(labourCost) > MAX_QUOTE_GHS) throw new Error(`Labour cost cannot exceed GHS ${MAX_QUOTE_GHS}.`);

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

    // ── Validate and total up materials ─────────────────────────────────────
    const cleanMaterials = [];
    let   materialsCost  = 0;

    for (const item of materials) {
        const qty       = Number(item.qty       || 0);
        const unitPrice = Number(item.unitPrice || 0);
        const name      = String(item.name      || '').trim();

        if (!name)         throw new Error('Each material must have a name.');
        if (qty <= 0)      throw new Error(`Quantity for "${name}" must be greater than 0.`);
        if (unitPrice <= 0) throw new Error(`Price for "${name}" must be greater than 0.`);

        const rowTotal = fmt(qty * unitPrice);
        materialsCost += rowTotal;

        cleanMaterials.push({ name, qty, unitPrice: fmt(unitPrice), total: rowTotal });
    }

    materialsCost        = fmt(materialsCost);
    const labourCostFmt  = fmt(Number(labourCost));
    const jobQuote       = fmt(labourCostFmt + materialsCost);
    const artisanEarns   = fmt(jobQuote * (1 - COMMISSION_RATE));
    const platformFee    = fmt(jobQuote * COMMISSION_RATE);

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
            quoteNote:           note.trim().slice(0, 300),
            commissionRate:      COMMISSION_RATE,   // locked at quote time
            artisanEarns,
            platformFee,
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
// ─────────────────────────────────────────────────────────────────────────────
async function approveJobQuote(auth, { bookingId }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');

    const preBooking = bookingSnap.data();

    // Only the customer of this booking may approve
    if (preBooking.customerId !== auth.uid) throw new Error('Not authorised for this booking.');

    // Must be in quoted status
    if (preBooking.status !== 'quoted') {
        throw new Error(`Quote cannot be approved — booking is ${preBooking.status}.`);
    }

    const jobQuote = Number(preBooking.jobQuote || 0);
    if (jobQuote <= 0) throw new Error('No valid quote to approve.');

    // ── Re-verify artisan is still active before locking funds ───────────────
    if (preBooking.artisanId) {
        const artisanSnap = await db().collection('artisans').doc(preBooking.artisanId).get();
        if (!artisanSnap.exists || artisanSnap.data().status !== 'active' ||
            artisanSnap.data().verificationStatus !== 'approved') {
            throw new Error('The artisan is no longer available. Please contact support.');
        }
    }

    const isInspection  = preBooking.track === 'inspection';
    const calloutCredit = (isInspection && preBooking.calloutPaid)
        ? fmt(Number(preBooking.calloutFee || 0))
        : 0;
    const escrowAmount  = fmt(Math.max(jobQuote - calloutCredit, 0));

    // ── Claim quoted → accepted atomically BEFORE moving money (F4) ───────────
    // This is the compare-and-set that serializes a concurrent approve/reject
    // (double-tap, two tabs) or approve racing a cancel. Whoever claims first
    // moves the booking out of 'quoted'; the loser re-reads a non-'quoted' status
    // and aborts before holding any escrow. Setting quoteApproved:true inside the
    // claim also flips off cancelInspectionBooking's guard, so a cancel that
    // arrives after this point is rejected rather than double-settling the callout.
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'customer',
        fromStatuses: ['quoted'],
        patch: {
            status:           'accepted',   // artisan can now go en_route
            quoteApproved:    true,
            quoteApprovedAt:  new Date().toISOString(),
            calloutCredit,
            escrowHeldAmount: escrowAmount,
        },
    });

    // ── Hold job escrow (idempotent via _escrow_locks/{bookingId}) ───────────
    // The claim already advanced the status; if this fails the booking is left
    // 'accepted' with quoteApproved:true and no job escrow — the completion path
    // and auto-release scheduler reconcile, and the customer sees the standard
    // "payment could not be secured" flow rather than a lost decision.
    if (escrowAmount > 0) {
        await escrow.holdFundsForBooking({
            bookingId,
            customerId:  booking.customerId,
            artisanId:   booking.artisanId || null,
            amount:      escrowAmount,
            callerAuth:  null,   // server-authoritative call
            kind:        'job',
        });
    }

    // ── Release the callout escrow to the artisan (credited into the job) ────
    // Failure is non-fatal: settleCallout flags the booking and the hourly
    // sweeper retries.
    if (calloutCredit > 0) {
        const pricing = require('./pricing');
        await pricing.settleCallout(booking, bookingId, 'artisan', 'quote_approved_credit');
    }

    // ── Notify artisan ───────────────────────────────────────────────────────
    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     'Quote Approved!',
        message:   `Your quote of GHS ${jobQuote.toFixed(2)} was approved. Payment is secured. You can now head to the job.`,
        actionUrl: `jobs.html`,
        bookingId,
    }).catch(() => {});

    console.log(`[quotes] Quote approved: booking=${bookingId} quote=GHS${jobQuote} credit=GHS${calloutCredit} escrowed=GHS${escrowAmount}`);
    return { success: true, jobQuote, calloutCredit, escrowAmount };
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
    const cleanReason = reason.trim().slice(0, 300);

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

module.exports = { submitJobQuote, approveJobQuote, rejectJobQuote };
