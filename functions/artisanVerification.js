'use strict';

/**
 * artisanVerification.js
 *
 * Cloud Functions for admin-driven artisan KYC approval workflow.
 *
 * Functions exported to index.js:
 *   - approveArtisan          (onCall, admin only)
 *   - rejectArtisan           (onCall, admin only)
 *   - requestMoreInfo         (onCall, admin only)
 *   - suspendArtisan          (onCall, admin only)
 *   - reinstateArtisan        (onCall, admin only)
 *   - backfillSearchKeywords  (onCall, admin only — one-time migration)
 *   - onVerificationSubmitted (onDocumentCreated Firestore trigger)
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { sendArtisanNotification }  = require('./notifications');
const { buildSearchKeywords }      = require('./shared/searchKeywords');

const { ADMIN_EMAILS, FIRESTORE_DB_ID } = require('./config');

// ── DB reference (custom database ID) ────────────────────────────────────────
function getDB() {
    return getFirestore(FIRESTORE_DB_ID);
}

// ── Auth guard ─────────────────────────────────────────────────────────────────
async function requireAdmin(auth) {
    if (!auth) throw new Error('Authentication required.');
    if (ADMIN_EMAILS.includes(auth.token?.email)) return true;

    const db   = getDB();
    const snap = await db.collection('admins').doc(auth.uid).get().catch(() => null);
    if (!snap?.exists) throw new Error('Unauthorized: Admin access only.');
    return true;
}

// ── Log helper ─────────────────────────────────────────────────────────────────
async function logAction(db, artisanId, action, adminEmail, adminUid, notes = '') {
    await db.collection('verification_logs').add({
        artisanId,
        action,
        adminEmail,
        adminUid,
        notes,
        timestamp: FieldValue.serverTimestamp(),
    }).catch(err => console.error('[verif-log] write error:', err.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// approveArtisan
// payload: { artisanId: string, notes?: string }
// ─────────────────────────────────────────────────────────────────────────────
async function approveArtisan(auth, { artisanId, notes = '' }) {
    await requireAdmin(auth);
    if (!artisanId) throw new Error('"artisanId" is required.');

    const db = getDB();

    // Read the artisan's current profile so we can regenerate searchKeywords
    // from their name, specialty, category, and commonSearchPhrases.
    // This ensures the artisan becomes immediately discoverable in search
    // the moment approval is committed — no separate indexing step required.
    const artisanSnap = await db.collection('artisans').doc(artisanId).get();
    if (!artisanSnap.exists) throw new Error(`Artisan document not found: ${artisanId}`);
    const artisanData    = artisanSnap.data();
    const searchKeywords = buildSearchKeywords(artisanData);

    const batch = db.batch();

    batch.update(db.collection('verification_requests').doc(artisanId), {
        verificationStatus: 'approved',
        status:             'approved',
        approvedAt:         FieldValue.serverTimestamp(),
        approvedBy:         auth.token?.email || auth.uid,
    });

    batch.update(db.collection('artisans').doc(artisanId), {
        verificationStatus: 'approved',
        status:             'active',   // artisan is now live on the marketplace
        isVerified:         true,
        isAvailable:        false,      // artisan toggles availability themselves
        searchKeywords,                 // generated from profile — makes artisan searchable
        approvedAt:         FieldValue.serverTimestamp(),
        approvedBy:         auth.token?.email || auth.uid,
        updatedAt:          new Date().toISOString(),
    });

    await batch.commit();

    await logAction(db, artisanId, 'approved', auth.token?.email || '', auth.uid, notes);

    await sendArtisanNotification(artisanId, {
        type:      'System',
        title:     '🎉 You\'re Approved!',
        message:   'Congratulations! Your HandyHub artisan profile has been approved. Log in to start accepting bookings.',
        actionUrl: 'dashboard.html',
    }).catch(() => {});

    return { approved: true, artisanId };
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectArtisan
// payload: { artisanId: string, reason: string }
// ─────────────────────────────────────────────────────────────────────────────
async function rejectArtisan(auth, { artisanId, reason }) {
    await requireAdmin(auth);
    if (!artisanId) throw new Error('"artisanId" is required.');
    if (!reason)    throw new Error('"reason" is required when rejecting.');

    const db    = getDB();
    const batch = db.batch();

    batch.update(db.collection('verification_requests').doc(artisanId), {
        verificationStatus: 'rejected',
        status:             'rejected',
        rejectedAt:         FieldValue.serverTimestamp(),
        rejectedBy:         auth.token?.email || auth.uid,
        rejectionReason:    reason,
    });

    batch.update(db.collection('artisans').doc(artisanId), {
        verificationStatus: 'rejected',
        isVerified:         false,
        rejectedAt:         FieldValue.serverTimestamp(),
        rejectionReason:    reason,
    });

    await batch.commit();

    await logAction(db, artisanId, 'rejected', auth.token?.email || '', auth.uid, reason);

    await sendArtisanNotification(artisanId, {
        type:      'System',
        title:     '❌ Verification Unsuccessful',
        message:   `Your HandyHub application could not be approved. Reason: ${reason}. Please re-submit with corrections.`,
        actionUrl: 'onboarding.html',
    }).catch(() => {});

    return { rejected: true, artisanId };
}

// ─────────────────────────────────────────────────────────────────────────────
// requestMoreInfo
// payload: { artisanId: string, notes: string }
// ─────────────────────────────────────────────────────────────────────────────
async function requestMoreInfo(auth, { artisanId, notes }) {
    await requireAdmin(auth);
    if (!artisanId) throw new Error('"artisanId" is required.');
    if (!notes)     throw new Error('"notes" is required when requesting info.');

    const db    = getDB();
    const batch = db.batch();

    batch.update(db.collection('verification_requests').doc(artisanId), {
        verificationStatus:  're_verification_required',
        status:              're_verification_required',
        infoRequestedAt:     FieldValue.serverTimestamp(),
        infoRequestedBy:     auth.token?.email || auth.uid,
        infoRequestNotes:    notes,
    });

    batch.update(db.collection('artisans').doc(artisanId), {
        verificationStatus: 're_verification_required',
    });

    await batch.commit();

    await logAction(db, artisanId, 'request_info', auth.token?.email || '', auth.uid, notes);

    await sendArtisanNotification(artisanId, {
        type:      'System',
        title:     '📋 Additional Information Required',
        message:   `Our team needs more info: ${notes}. Please log in and update your profile.`,
        actionUrl: 'onboarding.html',
    }).catch(() => {});

    return { infoRequested: true, artisanId };
}

// ─────────────────────────────────────────────────────────────────────────────
// suspendArtisan
// payload: { artisanId: string, reason?: string }
// ─────────────────────────────────────────────────────────────────────────────
async function suspendArtisan(auth, { artisanId, reason = '' }) {
    await requireAdmin(auth);
    if (!artisanId) throw new Error('"artisanId" is required.');

    const db    = getDB();
    const batch = db.batch();

    batch.update(db.collection('verification_requests').doc(artisanId), {
        verificationStatus: 'suspended',
        status:             'suspended',
        suspendedAt:        FieldValue.serverTimestamp(),
        suspendedBy:        auth.token?.email || auth.uid,
        suspensionReason:   reason,
    });

    batch.update(db.collection('artisans').doc(artisanId), {
        verificationStatus: 'suspended',
        isAvailable:        false,
        suspendedAt:        FieldValue.serverTimestamp(),
        suspendedBy:        auth.token?.email || auth.uid,
    });

    await batch.commit();

    await logAction(db, artisanId, 'suspended', auth.token?.email || '', auth.uid, reason);

    await sendArtisanNotification(artisanId, {
        type:    'System',
        title:   '⏸ Account Suspended',
        message: reason
            ? `Your account has been suspended. Reason: ${reason}. Contact support for assistance.`
            : 'Your account has been temporarily suspended. Please contact support.',
        actionUrl: 'dashboard.html',
    }).catch(() => {});

    return { suspended: true, artisanId };
}

// ─────────────────────────────────────────────────────────────────────────────
// reinstateArtisan
// payload: { artisanId: string, notes?: string }
// ─────────────────────────────────────────────────────────────────────────────
async function reinstateArtisan(auth, { artisanId, notes = '' }) {
    await requireAdmin(auth);
    if (!artisanId) throw new Error('"artisanId" is required.');

    const db = getDB();

    // Re-read the artisan profile to regenerate searchKeywords — their name or
    // category may have changed since original approval.
    const artisanSnap = await db.collection('artisans').doc(artisanId).get();
    if (!artisanSnap.exists) throw new Error(`Artisan document not found: ${artisanId}`);
    const artisanData    = artisanSnap.data();
    const searchKeywords = buildSearchKeywords(artisanData);

    const batch = db.batch();

    batch.update(db.collection('verification_requests').doc(artisanId), {
        verificationStatus: 'approved',
        status:             'approved',
        reinstatedAt:       FieldValue.serverTimestamp(),
        reinstatedBy:       auth.token?.email || auth.uid,
    });

    batch.update(db.collection('artisans').doc(artisanId), {
        verificationStatus: 'approved',
        status:             'active',
        isVerified:         true,
        searchKeywords,
        reinstatedAt:       FieldValue.serverTimestamp(),
        updatedAt:          new Date().toISOString(),
    });

    await batch.commit();

    await logAction(db, artisanId, 'reinstate', auth.token?.email || '', auth.uid, notes);

    await sendArtisanNotification(artisanId, {
        type:      'System',
        title:     '✅ Account Reinstated',
        message:   'Your HandyHub artisan account has been reinstated. You can resume accepting bookings.',
        actionUrl: 'dashboard.html',
    }).catch(() => {});

    return { reinstated: true, artisanId };
}

// ─────────────────────────────────────────────────────────────────────────────
// onVerificationSubmitted
// Firestore trigger — fires when a new verification_request is created.
// Notifies all admins by writing to a shared admin_notifications collection.
// ─────────────────────────────────────────────────────────────────────────────
async function onVerificationSubmitted(event) {
    try {
        const data      = event.data?.data();
        const artisanId = event.params?.artisanId;
        if (!data || !artisanId) return;

        const db = getDB();

        // Write admin notification
        await db.collection('admin_notifications').add({
            type:         'verification_submitted',
            artisanId,
            artisanName:  data.fullName  || 'Unknown',
            artisanPhone: data.phone     || '',
            category:     data.category  || '',
            message:      `New artisan verification submitted: ${data.fullName || artisanId}`,
            isRead:       false,
            createdAt:    FieldValue.serverTimestamp(),
        });

        // Optionally notify artisan that submission was received
        await sendArtisanNotification(artisanId, {
            type:    'System',
            title:   '✅ Application Submitted',
            message: 'Your verification documents have been submitted. Our team will review within 1–3 business days.',
        }).catch(() => {});

        console.log(`[verif-trigger] New submission from artisan: ${artisanId}`);
    } catch (err) {
        console.error('[verif-trigger] error:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// backfillSearchKeywords
// payload: {} (no arguments)
//
// ONE-TIME migration: regenerate searchKeywords for every artisan document that
// was created before artisanRepository.upsert() auto-generated keywords.
// Those artisans have searchKeywords: [] and are invisible in search even after
// verificationStatus is set to 'approved'.
//
// Safe to re-run — artisans whose keywords are already complete are skipped.
// Processes in batches of 400 to stay well under the Firestore 500-write limit.
//
// Usage (from admin dashboard or Firebase console):
//   const fn = httpsCallable(functions, 'backfillSearchKeywords');
//   const { data } = await fn({});
//   // data → { processed, skipped, errors, total }
// ─────────────────────────────────────────────────────────────────────────────
async function backfillSearchKeywords(auth) {
    await requireAdmin(auth);

    const db   = getDB();
    const snap = await db.collection('artisans').get();

    if (snap.empty) {
        console.log('[backfill] No artisan documents found.');
        return { processed: 0, skipped: 0, errors: 0, total: 0 };
    }

    const BATCH_SIZE = 400;
    let processed = 0, skipped = 0, errors = 0;
    let batch     = db.batch();
    let batchCount = 0;

    for (const doc of snap.docs) {
        try {
            const data        = doc.data();
            const newKeywords = buildSearchKeywords(data);

            // Skip if the stored keyword set already covers everything generated.
            // Use length + every() for an O(n) set-equality check.
            const existing = Array.isArray(data.searchKeywords) ? data.searchKeywords : [];
            const existingSet = new Set(existing);
            const alreadyComplete =
                newKeywords.length > 0 &&
                existing.length >= newKeywords.length &&
                newKeywords.every(k => existingSet.has(k));

            if (alreadyComplete) {
                skipped++;
                continue;
            }

            batch.update(doc.ref, {
                searchKeywords: newKeywords,
                updatedAt:      new Date().toISOString(),
            });
            batchCount++;
            processed++;

            if (batchCount >= BATCH_SIZE) {
                await batch.commit();
                batch      = db.batch();
                batchCount = 0;
                console.log(`[backfill] Committed batch — processed so far: ${processed}`);
            }
        } catch (err) {
            console.error(`[backfill] Failed for artisan ${doc.id}:`, err.message);
            errors++;
        }
    }

    if (batchCount > 0) await batch.commit();

    const total = snap.size;
    console.log(`[backfill] Done — total: ${total}, processed: ${processed}, skipped: ${skipped}, errors: ${errors}`);
    return { processed, skipped, errors, total };
}

module.exports = {
    approveArtisan,
    rejectArtisan,
    requestMoreInfo,
    suspendArtisan,
    reinstateArtisan,
    backfillSearchKeywords,
    onVerificationSubmitted,
};
