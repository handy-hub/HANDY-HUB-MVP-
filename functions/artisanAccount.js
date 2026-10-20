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

/** The base profile — the same rule-valid shape the email signup writes. Pure. */
function baseArtisanProfile({ uid, email, name, phone = '' }, nowIso) {
    const display = String(name || '').trim() || String(email || '').split('@')[0] || 'Artisan';
    return {
        id:                 uid,
        uid,
        name:               display.slice(0, 120),
        fullName:           String(name || '').trim().slice(0, 120),
        email:              String(email || ''),
        phone:              String(phone || '').slice(0, 32),
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
        txn.create(artisanRef, baseArtisanProfile({
            uid, email, name: token.name || '', phone: token.phone_number || '',
        }, new Date().toISOString()));
        return { result: 'created', verificationStatus: 'draft' };
    });
    return { ...outcome, emailVerified: token.email_verified === true };
}

module.exports = { ensureArtisanProfile, baseArtisanProfile };
