'use strict';

/**
 * functions/artisanAccount.js — the one way a signed-in person without a profile
 * becomes an artisan account (AR-09, 2026-10-20 artisan audit).
 *
 * Before this, three screens decided it themselves and disagreed:
 *   • signup.html (Google) created the profile in the browser;
 *   • login.html (Google, new user) sent them to onboarding with NO profile,
 *     where the guard showed "Access Denied… restricted to verified artisans";
 *   • login.html's "Create Account" tab created an account and profile in the
 *     browser, bypassing the server signup entirely.
 * A browser-side "create if missing" also cannot see admins/{uid} and can race a
 * second tab into overwriting a profile mid-onboarding.
 *
 * ensureArtisanProfile runs in ONE transaction: if the profile exists it is
 * returned untouched (no duplicate, whatever provider or how many attempts);
 * a customer or administrator account is refused (role isolation — see
 * docs/SECURITY_ROLE_ISOLATION.md); otherwise the same base profile the email
 * signup builds is created, unapproved. Authentication is not approval: the
 * account can sign in and onboard, and cannot take work until an admin approves
 * it — which requires a verified email (artisanVerification.approveArtisan).
 */

const { FIRESTORE_DB_ID } = require('./config');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

function accountError(reason, message) {
    const err = new Error(message);
    err.reason = reason;
    return err;
}

/**
 * The base profile — the same rule-valid shape the email signup writes. Pure.
 * It carries NO phone or email (CONTACT-001): this document is readable by every
 * signed-in account. Those go to artisans/{uid}/private/contact
 * (baseArtisanContact), and a customer gets the phone only inside a booking.
 */
function baseArtisanProfile({ uid, email, name }, nowIso) {
    const display = String(name || '').trim() || String(email || '').split('@')[0] || 'Artisan';
    return {
        id:                 uid,
        uid,
        name:               display.slice(0, 120),
        fullName:           String(name || '').trim().slice(0, 120),
        userType:           'artisan',
        status:             'pending',
        verificationStatus: 'draft',
        isOnline:           false,
        isAvailable:        false,
        rating:             0,
        reviewCount:        0,
        jobsCompleted:      0,
        availableBalance:   0,
        pendingBalance:     0,
        totalEarned:        0,
        withdrawnTotal:     0,
        walletBalance:      0,
        createdAt:          nowIso,
        updatedAt:          nowIso,
    };
}

/** The artisan's private contact record (CONTACT-001): owner and admins only. Pure. */
function baseArtisanContact({ uid, email, phone = '' }, nowIso) {
    return {
        artisanId: uid,
        email:     String(email || '').slice(0, 254),
        phone:     String(phone || '').slice(0, 32),
        createdAt: nowIso,
        updatedAt: nowIso,
    };
}

/**
 * @returns {{ result: 'existing'|'created', verificationStatus: string, emailVerified: boolean }}
 */
async function ensureArtisanProfile(auth) {
    if (!auth || !auth.uid) throw accountError('unauthenticated', 'Sign in first.');
    const uid   = auth.uid;
    const token = auth.token || {};
    const email = token.email || '';
    if (!email) throw accountError('no_email', 'This sign-in has no email address. Use an account with an email.');

    const artisanRef  = db().collection('artisans').doc(uid);
    const customerRef = db().collection('customers').doc(uid);
    const adminRef    = db().collection('admins').doc(uid);

    const outcome = await db().runTransaction(async (txn) => {
        const [a, c, ad] = await Promise.all([txn.get(artisanRef), txn.get(customerRef), txn.get(adminRef)]);
        if (a.exists) {
            const d = a.data();
            if (d.userType && d.userType !== 'artisan') {
                throw accountError('not_artisan', 'This account is not an artisan account.');
            }
            return { result: 'existing', verificationStatus: d.verificationStatus || 'draft' };
        }
        if (c.exists) {
            throw accountError('customer_account',
                'This email is already used for a Fidus X customer account. Sign up as an artisan with a different email.');
        }
        if (ad.exists) {
            throw accountError('admin_account', 'Administrator accounts cannot also be artisan accounts.');
        }
        const now = new Date().toISOString();
        txn.create(artisanRef, baseArtisanProfile({ uid, email, name: token.name || '' }, now));
        // Phone and email in the private record, in the same transaction.
        txn.set(artisanRef.collection('private').doc('contact'),
            baseArtisanContact({ uid, email, phone: token.phone_number || '' }, now), { merge: true });
        return { result: 'created', verificationStatus: 'draft' };
    });
    return { ...outcome, emailVerified: token.email_verified === true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Changing a VERIFIED claim (AR-10, 2026-10-20)
//
// An administrator approves an artisan's name (matched to their Ghana Card)
// and trade (which decides the jobs dispatch offers them). The profile page
// used to write both directly, so an approved plumber could rename themselves
// or become an "electrician" and start receiving electrical jobs with no one
// checking. firestore.rules now fixes those fields while an application is
// under review or decided (isSafeArtisanClaimUpdate); this is how an approved
// artisan changes them instead:
//
//   requestProfileChange  the artisan proposes new values and says why; the
//                         request is stored for review, and the profile shows
//                         it as pending. They keep working under the claims
//                         that were verified — nothing changes until review.
//   cancelProfileChange   the artisan withdraws a pending request.
//   reviewProfileChange   an administrator approves (the new values are
//                         applied to the profile and the verification record,
//                         in one transaction, and logged) or rejects (with a
//                         reason the artisan sees). A change that needs fresh
//                         documents is a re-verification: requestMoreInfo.
// ─────────────────────────────────────────────────────────────────────────────

// The trades an artisan can register under — the ones customers can book
// (shared/js/domain/artisanTrades.js, mirrored; the forms use the same list).
const { ARTISAN_TRADES, canonicalTrade } = require('./shared/artisanTrades');
const CLAIM_FIELDS = Object.freeze(['name', 'category', 'specialty']);

const changeRef = (uid) => db().collection('profile_change_requests').doc(uid);

/** Validate a proposed change against the current profile. Pure. */
function validateProfileChange(current, proposed) {
    const p = proposed && typeof proposed === 'object' ? proposed : {};
    const requested = {};
    if (p.name !== undefined) {
        const name = typeof p.name === 'string' ? p.name.trim().replace(/\s+/g, ' ') : '';
        if (name.length < 2 || name.length > 80 || !/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(name)) {
            throw accountError('invalid', 'Enter your full name as it appears on your Ghana Card (letters only).');
        }
        if (name !== String(current.name || '').trim()) requested.name = name;
    }
    if (p.category !== undefined) {
        const trade = ARTISAN_TRADES.find((t) => t.toLowerCase() === String(p.category || '').trim().toLowerCase());
        if (!trade) throw accountError('invalid', 'Choose one of the listed trades.');
        // An older value that means the same trade ('AC' for AC Repair) is no change.
        if (trade !== canonicalTrade(current.category)) requested.category = trade;
    }
    if (p.specialty !== undefined) {
        const specialty = typeof p.specialty === 'string' ? p.specialty.trim().replace(/\s+/g, ' ') : '';
        if (specialty.length < 2 || specialty.length > 60) {
            throw accountError('invalid', 'Describe your specialty in 2 to 60 characters.');
        }
        if (specialty !== String(current.specialty || '').trim()) requested.specialty = specialty;
    }
    if (!Object.keys(requested).length) {
        throw accountError('no_change', 'Nothing to change — these are already your verified details.');
    }
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    if (reason.length < 10 || reason.length > 500) {
        throw accountError('invalid', 'Tell us why in 10 to 500 characters, so the reviewer can check it.');
    }
    return { requested, reason };
}

async function requestProfileChange(auth, data = {}) {
    if (!auth || !auth.uid) throw accountError('unauthenticated', 'Sign in first.');
    const uid = auth.uid;
    const artisanRef = db().collection('artisans').doc(uid);
    const n = new Date().toISOString();
    return db().runTransaction(async (txn) => {
        const [a, existing] = await Promise.all([txn.get(artisanRef), txn.get(changeRef(uid))]);
        if (!a.exists || a.data().userType !== 'artisan') throw accountError('not_artisan', 'No artisan profile found.');
        const current = a.data();
        const vs = current.verificationStatus || 'draft';
        if (['draft', 'rejected', 're_verification_required'].includes(vs)) {
            throw accountError('editable', 'Your application is not under review — edit these details directly in onboarding.');
        }
        if (vs !== 'approved') {
            throw accountError('under_review', 'Your details are being reviewed. You can request a change once the review is complete.');
        }
        if (existing.exists && existing.data().status === 'pending') {
            throw accountError('pending', 'You already have a change waiting for review. Withdraw it first to send a different one.');
        }
        const { requested, reason } = validateProfileChange(current, data);
        const fields = Object.keys(requested);
        const before = {};
        fields.forEach((f) => { before[f] = current[f] ?? null; });
        txn.set(changeRef(uid), {
            artisanId: uid, status: 'pending', fields, current: before, requested, reason,
            createdAt: n, updatedAt: n, reviewedAt: null, reviewedBy: null, reviewNotes: null,
        });
        txn.update(artisanRef, { pendingProfileChange: { fields, requestedAt: n }, updatedAt: n });
        return { status: 'pending', fields };
    });
}

async function cancelProfileChange(auth) {
    if (!auth || !auth.uid) throw accountError('unauthenticated', 'Sign in first.');
    const uid = auth.uid;
    const n = new Date().toISOString();
    return db().runTransaction(async (txn) => {
        const r = await txn.get(changeRef(uid));
        if (!r.exists || r.data().status !== 'pending') throw accountError('none', 'There is no pending change to withdraw.');
        txn.update(changeRef(uid), { status: 'withdrawn', updatedAt: n });
        txn.update(db().collection('artisans').doc(uid), { pendingProfileChange: null, updatedAt: n });
        return { status: 'withdrawn' };
    });
}

async function reviewProfileChange(auth, { artisanId, decision, notes = '' } = {}) {
    const verification = require('./artisanVerification');
    await verification.requireAdmin(auth);
    if (!artisanId || typeof artisanId !== 'string') throw accountError('invalid', '"artisanId" is required.');
    if (decision !== 'approve' && decision !== 'reject') throw accountError('invalid', 'decision must be approve or reject.');
    const reviewNotes = typeof notes === 'string' ? notes.trim().slice(0, 500) : '';
    if (decision === 'reject' && reviewNotes.length < 5) {
        throw accountError('invalid', 'Give the artisan a reason when rejecting a change.');
    }
    const reviewer = auth.token?.email || auth.uid;
    const artisanRef = db().collection('artisans').doc(artisanId);
    const requestRef = db().collection('verification_requests').doc(artisanId);
    const n = new Date().toISOString();

    const result = await db().runTransaction(async (txn) => {
        const [r, a, vr] = await Promise.all([txn.get(changeRef(artisanId)), txn.get(artisanRef), txn.get(requestRef)]);
        if (!r.exists || r.data().status !== 'pending') throw accountError('none', 'This change request is no longer pending.');
        if (!a.exists) throw accountError('not_artisan', 'Artisan not found.');
        const req = r.data();
        const lastProfileChange = { status: decision === 'approve' ? 'approved' : 'rejected', fields: req.fields,
                                    notes: reviewNotes || null, reviewedAt: n };
        if (decision === 'reject') {
            txn.update(changeRef(artisanId), { status: 'rejected', reviewedAt: n, reviewedBy: reviewer, reviewNotes, updatedAt: n });
            txn.update(artisanRef, { pendingProfileChange: null, lastProfileChange, updatedAt: n });
            return { status: 'rejected', fields: req.fields };
        }
        // The values reviewed are the values stored on the request — never
        // re-read from the client — and they must still be valid now.
        const { requested } = validateProfileChange(a.data(), { ...req.requested, reason: req.reason });
        const patch = { ...requested, pendingProfileChange: null, lastProfileChange, updatedAt: n };
        if (requested.name) patch.fullName = requested.name;
        txn.update(artisanRef, patch);
        if (vr.exists) {
            const vrPatch = { updatedAt: n };
            if (requested.name) { vrPatch.name = requested.name; vrPatch.fullName = requested.name; }
            if (requested.category) vrPatch.category = requested.category;
            if (requested.specialty) vrPatch.specialty = requested.specialty;
            txn.update(requestRef, vrPatch);
        }
        txn.update(changeRef(artisanId), { status: 'approved', reviewedAt: n, reviewedBy: reviewer, reviewNotes, updatedAt: n });
        return { status: 'approved', fields: Object.keys(requested) };
    });

    await verification.logAction(db(), artisanId, `profile_change_${result.status}`, auth.token?.email || '', auth.uid,
        `${result.fields.join(', ')}${reviewNotes ? ` — ${reviewNotes}` : ''}`);
    return result;
}

/**
 * The artisanAccount callable: one deployed function for the account actions
 * above (the region's CPU quota is spent — tests/functions-capacity.test.cjs).
 */
async function handleArtisanAccount(auth, data = {}) {
    const action = (data && data.action) || 'ensure';
    switch (action) {
        case 'ensure':               return ensureArtisanProfile(auth);
        case 'requestProfileChange': return requestProfileChange(auth, data);
        case 'cancelProfileChange':  return cancelProfileChange(auth);
        case 'reviewProfileChange':  return reviewProfileChange(auth, data);
        default: throw accountError('invalid', `Unknown action "${action}".`);
    }
}

module.exports = {
    ensureArtisanProfile, baseArtisanProfile, baseArtisanContact,
    requestProfileChange, cancelProfileChange, reviewProfileChange, validateProfileChange,
    handleArtisanAccount, ARTISAN_TRADES,
};
