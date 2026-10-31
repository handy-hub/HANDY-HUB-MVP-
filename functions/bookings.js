'use strict';

/**
 * functions/bookings.js — Booking lifecycle Cloud Function triggers
 *
 * Triggers:
 *   onBookingStatusChanged — fires on every booking document update.
 *
 * ─── SERVER-AUTHORITATIVE ESCROW STATE MACHINE ───────────────────────────────
 * Escrow operations are driven exclusively by server-side status transitions.
 * Client-side calls to holdBookingFunds() / releaseEscrow() are deprecated —
 * they are idempotent no-ops protected by the _escrow_locks mechanism, but
 * should be removed from client code.
 *
 *   pending  → accepted  : holdFundsForBooking()  — funds locked; "accepted" notification sent
 *                           ONLY after hold succeeds. On failure → auto-cancelled; both notified.
 *   *        → cancelled : refundEscrow()          — held funds returned to customer immediately
 *   *        → completed : releaseEscrow()         — held funds paid to artisan wallet
 *
 * Zero-amount bookings (price == 0) skip escrow and proceed normally.
 *
 * ─── NOTIFICATION RULES ──────────────────────────────────────────────────────
 * pending  → accepted   : customer notified AFTER escrow hold succeeds
 * pending  → rejected   : customer notified IF booking was pre-matched (not dispatch-controlled)
 * accepted → en_route   : customer notified
 * en_route → in_progress: customer notified
 * in_progress → awaiting: customer notified
 * * → completed         : both notified; artisan jobsCompleted atomically incremented
 * * → cancelled         : both notified (suppressed for system_escrow_failure cancellations)
 * * → disputed          : both notified
 *
 * IMPORTANT: Requires a Firestore composite index on the escrow collection:
 *   Fields: bookingId (ASC), status (ASC)
 *   Used by: _findHeldEscrow() — called on every cancellation and completion
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { FieldValue }        = require('firebase-admin/firestore');
const { FUNCTIONS_REGION, FIRESTORE_DB_ID, BURST_CPU } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const escrow    = require('./financial/escrow');
const dispatch  = require('./dispatch');
const { isAllowlistedAdmin } = require('./config');

// Lazy Firestore singleton (Admin SDK)
let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

// ── Status transition notification rules ──────────────────────────────────────
const TRANSITIONS = [
    // deferUntilEscrowHeld: this notification is sent by the escrow path (below),
    // not the generic loop — customer is notified "accepted" only after funds are secured.
    {
        from: 'pending',
        to:   'accepted',
        notify: 'customer',
        title:  'Booking Accepted!',
        body:   (b) => `${b.artisanName || 'Your artisan'} has accepted your ${b.serviceType || 'service'} request. Your payment has been secured.`,
        type:   'booking_accepted',
        deferUntilEscrowHeld: true,
    },
    // Dispatch-controlled rejections are handled by dispatch.js (reset to 'pending').
    // This rule fires only for pre-matched bookings where dispatch never ran.
    {
        from: 'pending',
        to:   'rejected',
        notify: 'customer',
        title:  'Professional Unavailable',
        body:   (b) => `The ${b.serviceType || 'service'} professional was unable to accept your booking. Please try booking again.`,
        type:   'booking_rejected',
        onlyIfNotDispatched: true,
    },
    {
        from: 'accepted',
        to:   'en_route',
        notify: 'customer',
        title:  'Professional En Route',
        body:   (b) => `${b.artisanName || 'Your artisan'} is on the way to your location for your ${b.serviceType || 'service'} request.`,
        type:   'booking_en_route',
    },
    {
        from: 'en_route',
        to:   'in_progress',
        notify: 'customer',
        title:  'Job Started',
        body:   (b) => `${b.artisanName || 'Your artisan'} has arrived and started working on your ${b.serviceType || 'service'} request.`,
        type:   'booking_started',
    },
    {
        from: 'in_progress',
        to:   'awaiting',
        notify: 'customer',
        title:  'Job Complete — Confirm?',
        body:   (b) => `${b.artisanName || 'Your artisan'} has marked the ${b.serviceType || 'service'} job as done. Please confirm to release payment.`,
        type:   'booking_awaiting',
        // Deep-link the customer straight to the confirm/release control. The id
        // is appended below — tracking no longer guesses which booking is meant.
        customerActionUrl: 'live-tracking.html',
    },
    {
        from: null,
        to:   'completed',
        notify: 'both',
        title:        'Job Completed!',
        body:         (b) => `Your ${b.serviceType || 'service'} booking has been marked complete. Payment has been released to the professional.`,
        artisanTitle: 'Job Completed',
        artisanBody:  (b) => `You completed a ${b.serviceType || 'service'} job. Your earnings have been credited to your wallet.`,
        type: 'booking_completed',
    },
    {
        from: null,
        to:   'cancelled',
        notify: 'both',
        title:        'Booking Cancelled',
        body:         (b) => `Your ${b.serviceType || 'service'} booking has been cancelled.`,
        artisanTitle: 'Booking Cancelled',
        artisanBody:  (b) => `A ${b.serviceType || 'service'} booking has been cancelled.`,
        type: 'booking_cancelled',
        // Suppressed when cancelledBy === 'system_escrow_failure' — both parties were
        // already notified with specific payment failure context by _handleEscrowHoldFailure.
        skipIfSystemCancelled: true,
        // A server path that cancels AND notifies (cancelInspectionBooking, the
        // timeout sweep, the final quote rejection) lists the parties it told in
        // `cancelNotified`, in the same write as the status. This rule tells
        // only the others: one notice per party, and nobody left with none
        // (ART-NOTIF-003). Clients cannot write the field (firestore.rules).
        skipPartiesAlreadyNotified: true,
    },
    {
        from: null,
        to:   'disputed',
        notify: 'both',
        title:        'Dispute Raised',
        body:         (b) => `A dispute has been raised on your ${b.serviceType || 'service'} booking. Our team will review and contact you shortly.`,
        artisanTitle: 'Dispute Raised',
        artisanBody:  (b) => `A dispute has been raised on your ${b.serviceType || 'service'} booking. Funds are frozen pending admin review.`,
        type: 'booking_disputed',
    },
];

function _str(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }

// ── Escrow helpers ────────────────────────────────────────────────────────────

// Find the 'held' escrow document of the given kind for a booking.
// Requires composite Firestore index: escrow → bookingId ASC, status ASC.
//
// kind filtering is done in code (not in the query) because escrow documents
// created before the inspection track existed carry no `kind` field — those
// are always job escrows. This helper must NEVER return a callout escrow:
// callout fees settle exclusively through settleCallout() (functions/pricing.js),
// whose refund-vs-release decision this generic trigger cannot make. During the
// approveJobQuote window a booking can briefly hold BOTH escrows, so a bare
// limit(1) could previously pick either one nondeterministically.
async function _findHeldEscrow(bookingId, kind = 'job') {
    const snap = await db()
        .collection('escrow')
        .where('bookingId', '==', bookingId)
        .where('status',    '==', 'held')
        .limit(5)
        .get();
    if (snap.empty) return null;
    const doc = snap.docs.find(d => (d.data().kind || 'job') === kind);
    return doc ? { id: doc.id, ...doc.data() } : null;
}

// Attempt to hold funds for an accepted booking.
// Returns { success: true } or { success: false, reason: string }.
async function _holdEscrowForAcceptance(bookingId, bookingData) {
    const customerId = bookingData.customerId || bookingData.userId || null;
    const artisanId  = bookingData.artisanId  || null;
    const amount     = Number(bookingData.price || bookingData.total || 0);

    if (!customerId) {
        console.error(`[bookings] Escrow hold skipped — no customerId: booking=${bookingId}`);
        return { success: true }; // no financial party; allow proceed
    }

    if (amount < 0) {
        console.error(`[bookings] Negative amount rejected: booking=${bookingId} amount=${amount}`);
        return { success: false, reason: 'negative_amount' };
    }

    if (amount === 0) {
        console.log(`[bookings] Zero-amount booking=${bookingId} — escrow skipped (cash/external payment).`);
        return { success: true };
    }

    try {
        const result = await escrow.holdFundsForBooking({
            bookingId,
            customerId,
            artisanId:  artisanId || null,
            amount,
            // null = system call from Admin SDK context; escrow.js treats this as server-authoritative.
            callerAuth: null,
        });

        const tag = result.idempotent ? '[IDEMPOTENT]' : '[NEW]';
        console.log(`[bookings] ${tag} Escrow held: booking=${bookingId} escrow=${result.escrowId} amount=GHS ${amount}`);
        return { success: true };

    } catch (holdErr) {
        console.error(`[bookings] Escrow hold FAILED: booking=${bookingId} reason="${holdErr.message}"`);
        return { success: false, reason: holdErr.message };
    }
}

// Release held escrow on job completion.
// Non-fatal: the 6-hour auto-release scheduler handles stuck escrows.
async function _releaseEscrowForBooking(bookingId) {
    try {
        const heldEscrow = await _findHeldEscrow(bookingId);
        if (!heldEscrow) {
            console.log(`[bookings] No held escrow for completed booking=${bookingId} — skipping release (zero-value or already released).`);
            return;
        }
        await escrow.releaseEscrow(heldEscrow.id, {
            releasedBy: 'booking_completion_trigger',
            callerAuth: null,
        });
        console.log(`[bookings] Escrow released: booking=${bookingId} escrow=${heldEscrow.id}`);
    } catch (releaseErr) {
        // Non-fatal. Auto-release scheduler (every 6h) will retry within ESCROW_AUTO_RELEASE_DAYS.
        console.error(`[bookings] Escrow release FAILED: booking=${bookingId} reason="${releaseErr.message}". Auto-release scheduler will retry.`);
    }
}

// Refund held escrow on any cancellation.
// Non-fatal: auto-release scheduler refunds stuck escrows within 7 days.
async function _refundEscrowForBooking(bookingId, bookingData) {
    try {
        const heldEscrow = await _findHeldEscrow(bookingId);
        if (!heldEscrow) {
            // Normal for pre-acceptance cancellations — no escrow was ever held.
            console.log(`[bookings] No held escrow for cancelled booking=${bookingId} — nothing to refund.`);
            return;
        }
        const reason = bookingData.cancellationReason || 'Booking cancelled';
        await escrow.refundEscrow(heldEscrow.id, {
            reason,
            refundedBy: 'booking_cancellation_trigger',
            callerAuth: null,
        });
        console.log(`[bookings] Escrow refunded: booking=${bookingId} escrow=${heldEscrow.id}`);
    } catch (refundErr) {
        console.error(`[bookings] Escrow refund FAILED: booking=${bookingId} reason="${refundErr.message}". Auto-release scheduler will refund within 7 days.`);
    }
}

// Settle the callout escrow for inspection-track cancellations that did NOT go
// through cancelInspectionBooking — i.e. admin cancels (cancelBookingAsAdmin
// writes only the status and relies on this trigger for money movement) or any
// other Admin-SDK write. The CF paths (cancelInspectionBooking, rejectJobQuote
// final, checkBookingTimeouts) all settle BEFORE writing 'cancelled', so
// calloutSettled / calloutSettlePending is already present and this is a no-op
// for them. Direction follows the same fairness rule as cancelInspectionBooking:
// inspection delivered before cancellation → fee pays the artisan; otherwise →
// customer refunded. settleCallout() remains the only settlement path.
//
// EMERGENCY TRACK: the emergency fee is also a 'callout' escrow
// (payEmergencyCallout), so _refundEscrowForBooking — job escrow only — never
// returned it. The customer page used to refund it by calling the refundBooking
// callable itself, which also let a customer refund the fee at any other time.
// That callable is now admin-only, so the refund happens here, from the
// cancellation itself. A customer can only cancel an emergency before the
// artisan sets out (firestore.rules), so that refund is what the page did
// before, now decided by the server; a cancellation after arrival — which only
// an administrator can make — pays the artisan for the visit.
//
// The direction comes from pricing.calloutDecision — the one definition of
// "was the visit delivered?" (AR-07). For an emergency that means the artisan
// arrived; a quote alone (sent from 'accepted', before travel) is not a visit.
async function _settleCalloutOnCancellation(bookingId, before, after) {
    await _settleCalloutFor(bookingId, after, { priorStatus: before.status }, 'cancelled_out_of_band');
}

// Settle the callout when the job COMPLETES (AR-07).
//
// Completion used to release only the job escrow (_findHeldEscrow is
// kind-filtered), so an emergency callout — the one money on an emergency job
// with no quote — stayed held until autoReleaseEscrow found it seven days
// later. The visit is delivered by definition once the job is completed, so the
// fee is the artisan's now. Idempotent: settleCallout is a no-op once the
// booking records calloutSettled, and a failure flags calloutSettlePending for
// the hourly retry instead of blocking completion.
async function _settleCalloutOnCompletion(bookingId, after) {
    await _settleCalloutFor(bookingId, after, { event: 'completed' }, 'job_completed');
}

async function _settleCalloutFor(bookingId, booking, ctx, why) {
    if (!['inspection', 'emergency'].includes(booking.track)) return;
    if (!booking.calloutPaid || booking.calloutSettled || booking.calloutSettlePending) return;
    try {
        const pricing  = require('./pricing');
        const decision = pricing.calloutDecision(booking, ctx);
        if (decision.hold || !decision.to) {
            console.log(`[bookings] Callout left held (${decision.why}) booking=${bookingId}`);
            return;
        }
        await pricing.settleCallout(booking, bookingId, decision.to, why);
        console.log(`[bookings] Callout settled to ${decision.to} (${decision.why}) booking=${bookingId}`);
    } catch (err) {
        // settleCallout flags calloutSettlePending itself; this catch is belt-and-braces.
        console.error(`[bookings] Callout settlement (${why}) failed booking=${bookingId}:`, err.message);
    }
}

// Cancel a booking after escrow hold failure and notify both parties with specific context.
// Triggers a second onBookingStatusChanged invocation (accepted → cancelled).
// skipIfSystemCancelled on the 'cancelled' TRANSITIONS rule suppresses duplicate
// generic cancellation notifications in that second invocation.
async function _handleEscrowHoldFailure(bookingId, bookingData, reason) {
    const customerId  = bookingData.customerId || bookingData.userId || null;
    const artisanId   = bookingData.artisanId  || null;
    const serviceType = bookingData.serviceType || bookingData.service || 'service';

    if (customerId) {
        await sendNotification(customerId, {
            type:      'Payments',
            title:     'Payment Failed — Booking Cancelled',
            message:   `Your ${serviceType} booking was accepted but payment could not be secured: ${reason}. Please top up your wallet and rebook.`,
            actionUrl: 'topup.html',
            metadata:  { bookingId },
        }).catch(err => console.error('[bookings] escrow-fail notif error:', err?.message));
    }

    if (artisanId) {
        await sendArtisanNotification(artisanId, {
            type:      'Bookings',
            title:     'Booking Cancelled',
            message:   `A ${serviceType} booking was cancelled because the customer's payment could not be processed.`,
            actionUrl: 'dashboard.html',
            metadata:  { bookingId },
        }).catch(err => console.error('[bookings] artisan escrow-fail notif error:', err?.message));
    }

    try {
        await db().collection('bookings').doc(bookingId).update({
            status:             'cancelled',
            cancellationReason: `Auto-cancelled: ${reason}`,
            cancelledBy:        'system_escrow_failure',
            updatedAt:          new Date().toISOString(),
        });
        console.log(`[bookings] Booking ${bookingId} auto-cancelled (escrow failure: ${reason}).`);
    } catch (cancelErr) {
        console.error(`[bookings] Could not auto-cancel booking ${bookingId}: ${cancelErr.message}`);
    }
}

// ── Main trigger ───────────────────────────────────────────────────────────────

// Fires on every booking write, so it takes a full vCPU (BURST_CPU).
const onBookingStatusChanged = onDocumentUpdated(
    { document: 'bookings/{bookingId}', database: FIRESTORE_DB_ID, region: FUNCTIONS_REGION, ...BURST_CPU },
    async (event) => {
        const before    = event.data.before.data();
        const after     = event.data.after.data();
        const bookingId = event.params.bookingId;

        const prevStatus = _str(before.status);
        const nextStatus = _str(after.status);

        if (prevStatus === nextStatus) return; // metadata-only update, no status change

        const rule = TRANSITIONS.find(t =>
            (t.from === null || _str(t.from) === prevStatus) &&
            _str(t.to) === nextStatus
        );

        if (!rule) {
            console.log(`[bookings] No notification rule for ${prevStatus}→${nextStatus} booking=${bookingId}`);
        }

        const customerId        = after.customerId || after.userId || null;
        const artisanId         = after.artisanId  || null;
        const isSystemCancelled = after.cancelledBy === 'system_escrow_failure';

        // ── Stamp the assigned professional's identity, server-side ──────────
        //
        // The artisan app writes artisanName itself when it accepts, which means
        // (a) it is client-asserted and therefore spoofable, and (b) it is the
        // ONLY identity field written — so the customer got a name and nothing
        // else: no photo, no rating, no verification badge, no job count. The
        // customer could not answer "who is coming to my home?".
        //
        // Resolved once here, from artisans/{uid}, at the moment of acceptance.
        // Every customer surface then reads these fields through
        // resolveArtisan() in shared/js/domain/bookingTruth.js.
        if (prevStatus === 'pending' && nextStatus === 'accepted' && artisanId) {
            try {
                const aSnap = await db().collection('artisans').doc(artisanId).get();
                if (aSnap.exists) {
                    const a = aSnap.data();
                    await db().collection('bookings').doc(bookingId).update({
                        artisanName:     a.fullName || a.name || null,
                        artisanPhoto:    a.profileImage || null,
                        artisanRating:   typeof a.rating === 'number' ? a.rating : null,
                        artisanCategory: a.specialty || a.category || null,
                        artisanVerified: a.verificationStatus === 'approved',
                        artisanJobsCompleted: typeof a.jobsCompleted === 'number' ? a.jobsCompleted : null,
                        updatedAt: new Date().toISOString(),
                    });
                }
                // The artisan's phone for THIS booking's customer (CONTACT-001).
                // Never on the booking or the public profile: it comes from
                // artisans/{uid}/private/contact, and firestore.rules let the
                // customer read it only while contactDisclosed(booking) — the
                // same window the artisan gets the customer's phone.
                // Until the contact migration has copied a legacy profile's phone
                // into private/contact, fall back to the public field — it is
                // only ever written HERE, into the windowed private record.
                // TRANSITION ONLY: once the contact STRIP migration has run, no
                // public profile holds a phone and legacyPhone is always empty —
                // this fallback is dead and can be removed then.
                const cSnap = await db().collection('artisans').doc(artisanId)
                    .collection('private').doc('contact').get();
                const legacyPhone  = aSnap.exists ? aSnap.data().phone : '';
                const artisanPhone = String((cSnap.exists && cSnap.data().phone) || legacyPhone || '').trim();
                if (artisanPhone) {
                    await db().collection('bookings').doc(bookingId)
                        .collection('private').doc('artisanContact').set({
                            bookingId,
                            artisanId,
                            artisanPhone: artisanPhone.slice(0, 32),
                            updatedAt: new Date().toISOString(),
                        });
                }
            } catch (err) {
                // Non-fatal: the customer UI renders an honest "Your professional"
                // rather than a fabricated identity if this could not be stamped.
                console.warn(`[bookings] Could not stamp artisan identity on ${bookingId}: ${err.message}`);
            }
        }

        const ctx = {
            bookingId,
            serviceType:  after.serviceType  || after.service || 'Service',
            artisanName:  after.artisanName  || after.proName || null,
            customerName: after.customerName || null,
        };

        // ── Immediate notifications ─────────────────────────────────────────
        // The 'pending → accepted' rule has deferUntilEscrowHeld: true.
        // Its notification is sent conditionally after escrow succeeds (see below).
        // All other transitions are notified immediately.
        const promises = [];

        if (rule && !rule.deferUntilEscrowHeld) {
            const shouldSkip =
                // Dispatch-controlled rejections: dispatch.js handles these itself
                (rule.onlyIfNotDispatched &&
                    (before.dispatchStatus === 'dispatched' ||
                     before.dispatchStatus === 'searching')) ||
                // System-cancelled bookings: payment-failure notifications already sent
                (rule.skipIfSystemCancelled && isSystemCancelled);

            if (!shouldSkip) {
                // FIELD MAPPING (F7): notifications.js writes `message` (not
                // `body`), deep-links via `actionUrl`, and stores the bookingId in
                // `metadata.bookingId`. The rules define `body`/`artisanBody`, so we
                // map body→message and supply actionUrl + metadata here. Before this
                // fix every generic transition notification (en_route, in_progress,
                // awaiting, completed, cancelled, disputed) was written with an EMPTY
                // message body, no working deep-link, and no bookingId in metadata.
                // A push notification is opened by the service worker, which
                // navigates straight to actionUrl and never runs the in-app
                // resolver — so any booking-specific destination has to carry the
                // booking id here or it arrives ambiguous. (In-app taps resolve
                // through notificationHref() in shared/js/domain/bookingRouter.js,
                // which reads metadata.bookingId and picks the right screen.)
                const withBooking = (url) => {
                    if (!url || !bookingId) return url;
                    // List/home destinations are deliberately generic — leave them.
                    if (url === 'booking.html' || url === 'dashboard.html' || url === 'jobs.html') return url;
                    if (url.includes('?')) return url;
                    const param = url.startsWith('book-request.html') ? 'resume' : 'bookingId';
                    return `${url}?${param}=${encodeURIComponent(bookingId)}`;
                };

                const custAction = withBooking(rule.customerActionUrl) || 'booking.html';
                const artAction  = withBooking(rule.artisanActionUrl)  || 'dashboard.html';

                // Honoured only when it arrives WITH the cancellation: a value that
                // was already on the booking was not written by the cancelling
                // path, so it can never silence anyone.
                const alreadyTold = rule.skipPartiesAlreadyNotified && Array.isArray(after.cancelNotified) &&
                                    before.cancelNotified === undefined
                    ? after.cancelNotified : [];

                if ((rule.notify === 'customer' || rule.notify === 'both') && customerId &&
                    !alreadyTold.includes('customer')) {
                    promises.push(
                        sendNotification(customerId, {
                            type:      rule.type,
                            title:     rule.title,
                            message:   typeof rule.body === 'function' ? rule.body(ctx) : rule.body,
                            actionUrl: custAction,
                            metadata:  { bookingId },
                        }).catch(err => console.error('[bookings] customer notif error:', err?.message))
                    );
                }

                if ((rule.notify === 'artisan' || rule.notify === 'both') && artisanId &&
                    !alreadyTold.includes('artisan')) {
                    const artisanCopy = rule.artisanBody || rule.body;
                    promises.push(
                        sendArtisanNotification(artisanId, {
                            type:      rule.type,
                            title:     rule.artisanTitle || rule.title,
                            message:   typeof artisanCopy === 'function' ? artisanCopy(ctx) : artisanCopy,
                            actionUrl: artAction,
                            metadata:  { bookingId },
                        }).catch(err => console.error('[bookings] artisan notif error:', err?.message))
                    );
                }
            }
        }

        // Atomically increment artisan jobsCompleted on completion (TOCTOU-safe).
        if (nextStatus === 'completed' && artisanId) {
            promises.push(
                db().collection('artisans').doc(artisanId).update({
                    jobsCompleted: FieldValue.increment(1),
                    updatedAt:     new Date().toISOString(),
                }).catch(err => console.error('[bookings] jobsCompleted increment error:', err?.message))
            );
        }

        await Promise.all(promises);

        // ── SERVER-AUTHORITATIVE ESCROW OPERATIONS ────────────────────────────
        //
        // Run AFTER initial notifications so artisan "new job" alerts are delivered
        // before payment processing begins.

        // 1. HOLD — pending → accepted
        //    Lock customer wallet funds in escrow.
        //    "Booking Accepted" customer notification sent ONLY after hold succeeds.
        //    On failure: auto-cancel booking, notify both parties with payment context.
        if (prevStatus === 'pending' && nextStatus === 'accepted') {
            const holdResult = await _holdEscrowForAcceptance(bookingId, after);

            if (holdResult.success) {
                if (customerId) {
                    // Track-aware accept notification.
                    //
                    // INSPECTION TRACK (F2): accepting does NOT secure payment —
                    // the customer still has to pay the callout fee, and that
                    // control lives ONLY on book-request.html?resume=ID. Point the
                    // notification straight there so a customer who left the flow
                    // can get back to pay. Without this the booking stalls at
                    // 'accepted' forever (the pay screen was otherwise unreachable).
                    //
                    // Note on fields: notifications.js reads `message` (not `body`)
                    // and `metadata.bookingId`, and deep-links FCM taps via
                    // `actionUrl`. These are passed explicitly here so the recovery
                    // notification actually carries copy and a working link.
                    const isInspection = after.track === 'inspection' && !after.calloutPaid;
                    const artisanLabel = after.artisanName || after.proName || 'A professional';
                    const svc          = after.serviceType || after.service || 'service';

                    const notif = isInspection
                        ? {
                            type:      'Bookings',
                            title:     'Pay your visit fee',
                            message:   `${artisanLabel} accepted your ${svc} inspection. Pay the callout fee to lock it in — it's credited toward your final job price.`,
                            actionUrl: `book-request.html?resume=${bookingId}`,
                            metadata:  { bookingId },
                        }
                        : {
                            type:      'Bookings',
                            title:     'Booking Accepted!',
                            message:   `${artisanLabel} has accepted your ${svc} request. Your payment has been secured.`,
                            actionUrl: 'booking.html',
                            metadata:  { bookingId },
                        };

                    await sendNotification(customerId, notif)
                        .catch(err => console.error('[bookings] accepted notif error:', err?.message));
                }
            } else {
                await _handleEscrowHoldFailure(
                    bookingId,
                    after,
                    holdResult.reason || 'Payment could not be processed'
                );
            }
        }

        // 2. RELEASE — * → completed
        //    Transfer held escrow to artisan wallet (minus platform commission).
        //    Non-fatal: auto-release scheduler handles stuck escrows every 6 hours.
        if (nextStatus === 'completed') {
            await _releaseEscrowForBooking(bookingId);
            await _settleCalloutOnCompletion(bookingId, after);
        }

        // 3. REFUND — * → cancelled
        //    Return the held JOB escrow to the customer immediately on any
        //    cancellation (_findHeldEscrow is kind-filtered — it never touches
        //    the callout escrow). The callout, if still unsettled, is settled
        //    by the fairness rule below.
        //    Non-fatal: auto-release scheduler refunds stuck escrows within 7 days.
        if (nextStatus === 'cancelled') {
            await _refundEscrowForBooking(bookingId, after);
            await _settleCalloutOnCancellation(bookingId, before, after);
        }

        // ── Completion logging ─────────────────────────────────────────────────
        if (rule) {
            console.log(`[bookings] Dispatched: ${prevStatus}→${nextStatus} booking=${bookingId}`);
        }
        if (nextStatus === 'completed' && artisanId) {
            console.log(`[bookings] Incremented jobsCompleted for artisan=${artisanId}`);
        }

        // ── Dispatch side-effects ──────────────────────────────────────────────
        // Eliminates the second onDocumentUpdated trigger (onBookingDispatchEvent)
        // — halves Cloud Function invocations per booking write.
        await dispatch.handleDispatchEvent(before, after, bookingId);
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// cancelBookingAsAdmin — admin-driven cancellation.
//
// This intentionally does NOT touch escrow/wallet balances directly. It only
// validates the request and writes `status: 'cancelled'` on the booking doc.
// The existing onBookingStatusChanged trigger above (see "3. REFUND" branch)
// already runs _refundEscrowForBooking() for ANY write that transitions a
// booking to 'cancelled', regardless of who made it — so the real money
// movement stays inside that one, already-audited code path instead of being
// duplicated here.
// ─────────────────────────────────────────────────────────────────────────────
const NON_CANCELLABLE_STATUSES = new Set(['completed', 'cancelled', 'rejected']);

async function isAdminAuth(auth) {
    if (!auth) return false;
    if (isAllowlistedAdmin(auth.token)) return true;
    const snap = await db().collection('admins').doc(auth.uid).get().catch(() => null);
    return snap?.exists && snap.data().userType === 'admin';
}

/**
 * @param {object} auth  Firebase auth context (must be an admin)
 * @param {object} data
 *   @param {string} data.bookingId
 *   @param {string} data.reason    Required — becomes cancellationReason
 */
async function cancelBookingAsAdmin(auth, { bookingId, reason } = {}) {
    if (!(await isAdminAuth(auth))) throw new Error('Unauthorized: admin access only.');
    if (!bookingId) throw new Error('"bookingId" is required.');
    if (!reason)    throw new Error('"reason" is required to cancel a booking.');

    const firestore   = db();
    const bookingRef  = firestore.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error(`Booking not found: ${bookingId}`);

    const currentStatus = _str(bookingSnap.data().status);
    if (NON_CANCELLABLE_STATUSES.has(currentStatus)) {
        throw new Error(`Cannot cancel a booking with status "${bookingSnap.data().status}".`);
    }

    const adminEmail = auth.token?.email || auth.uid;

    // Re-check status inside a transaction to prevent a race against a
    // concurrent customer/artisan status change (e.g. artisan marks
    // "completed" at the same moment an admin cancels).
    await firestore.runTransaction(async (txn) => {
        const live = await txn.get(bookingRef);
        if (!live.exists) throw new Error(`Booking not found: ${bookingId}`);
        const liveStatus = _str(live.data().status);
        if (NON_CANCELLABLE_STATUSES.has(liveStatus)) {
            throw new Error(
                `Cannot cancel: booking status is now "${live.data().status}". Concurrent update prevented.`
            );
        }
        txn.update(bookingRef, {
            status:             'cancelled',
            cancellationReason: reason,
            cancelledBy:        `admin:${adminEmail}`,
            updatedAt:          new Date().toISOString(),
        });
    });

    await firestore.collection('admin_action_logs').add({
        action:     'cancel_booking',
        bookingId,
        reason,
        adminEmail,
        adminUid:   auth.uid,
        timestamp:  FieldValue.serverTimestamp(),
    }).catch(err => console.error('[admin-cancel-log] write error:', err.message));

    return { cancelled: true, bookingId };
}

module.exports = { onBookingStatusChanged, cancelBookingAsAdmin };
