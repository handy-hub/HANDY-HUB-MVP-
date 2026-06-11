'use strict';

/**
 * quotes.js — Job quote lifecycle
 *
 * Flow:
 *   1. Artisan submits quote (labour + optional materials list)
 *      → booking gains jobQuote, materials fields
 *      → status: accepted → quoted
 *      → customer notified
 *
 *   2. Customer approves quote
 *      → escrow holds jobQuote amount
 *      → status: quoted → accepted  (artisan can now go en_route)
 *      → artisan notified
 *
 *   3. Customer rejects quote
 *      → status: quoted → accepted  (artisan can resubmit)
 *      → artisan notified with rejection
 */

const { FieldValue } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID, COMMISSION_RATE } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const escrow = require('./financial/escrow');

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

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');

    const booking = bookingSnap.data();

    // Only the assigned artisan may submit a quote
    if (booking.artisanId !== auth.uid) throw new Error('Not authorised for this booking.');

    // Only valid from accepted status
    if (booking.status !== 'accepted') {
        throw new Error(`Cannot submit quote — booking is ${booking.status}.`);
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

    // ── Write quote to booking ───────────────────────────────────────────────
    await bookingRef.update({
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
        updatedAt:           FieldValue.serverTimestamp(),
    });

    // ── Notify customer ──────────────────────────────────────────────────────
    const artisanName = booking.artisanName || 'Your artisan';
    const serviceType = booking.serviceType || 'service';

    await sendNotification(booking.customerId, {
        type:      'Bookings',
        title:     '💰 Quote Ready for Approval',
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

    const booking = bookingSnap.data();

    // Only the customer of this booking may approve
    if (booking.customerId !== auth.uid) throw new Error('Not authorised for this booking.');

    // Must be in quoted status
    if (booking.status !== 'quoted') {
        throw new Error(`Quote cannot be approved — booking is ${booking.status}.`);
    }

    const jobQuote = Number(booking.jobQuote || 0);
    if (jobQuote <= 0) throw new Error('No valid quote to approve.');

    // ── Hold escrow for full quote amount ────────────────────────────────────
    await escrow.holdFundsForBooking({
        bookingId,
        customerId:  booking.customerId,
        artisanId:   booking.artisanId || null,
        amount:      jobQuote,
        callerAuth:  null,   // server-authoritative call
    });

    // ── Update booking status ────────────────────────────────────────────────
    await bookingRef.update({
        status:          'accepted',    // artisan can now go en_route
        quoteApproved:   true,
        quoteApprovedAt: new Date().toISOString(),
        updatedAt:       FieldValue.serverTimestamp(),
    });

    // ── Notify artisan ───────────────────────────────────────────────────────
    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     '✅ Quote Approved!',
        message:   `Your quote of GHS ${jobQuote.toFixed(2)} was approved. Payment is secured. You can now head to the job.`,
        actionUrl: `jobs.html`,
        bookingId,
    }).catch(() => {});

    console.log(`[quotes] Quote approved: booking=${bookingId} amount=GHS${jobQuote}`);
    return { success: true, jobQuote };
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectJobQuote
//
// Called by: customer app
// Payload: { bookingId, reason? }
// Artisan is notified and can resubmit a new quote.
// ─────────────────────────────────────────────────────────────────────────────
async function rejectJobQuote(auth, { bookingId, reason = '' }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');

    const booking = bookingSnap.data();

    if (booking.customerId !== auth.uid) throw new Error('Not authorised for this booking.');
    if (booking.status !== 'quoted')     throw new Error(`Cannot reject — booking is ${booking.status}.`);

    const prevQuote = booking.jobQuote;

    // ── Revert to accepted so artisan can resubmit ───────────────────────────
    await bookingRef.update({
        status:           'accepted',
        quoteApproved:    false,
        quoteRejectedAt:  new Date().toISOString(),
        quoteRejectionReason: reason.trim().slice(0, 300),
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
        updatedAt:        FieldValue.serverTimestamp(),
    });

    // ── Notify artisan ───────────────────────────────────────────────────────
    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     '❌ Quote Rejected',
        message:   reason
            ? `Customer rejected your GHS ${prevQuote} quote: "${reason}". You can submit a new quote.`
            : `Customer rejected your GHS ${prevQuote} quote. You can submit a revised quote.`,
        actionUrl: 'jobs.html',
        bookingId,
    }).catch(() => {});

    console.log(`[quotes] Quote rejected: booking=${bookingId} prevQuote=GHS${prevQuote}`);
    return { success: true };
}

module.exports = { submitJobQuote, approveJobQuote, rejectJobQuote };
